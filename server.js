// server.js — WhatsApp ↔ Drive ↔ Sheets (versão simples)
// Requisitos no package.json: axios, express, googleapis, mime-types

import express from "express";
import axios from "axios";
import { google } from "googleapis";
import mime from "mime-types";

// ====== ENV ======
const WHATSAPP_TOKEN   = process.env.WHATSAPP_TOKEN;   // token “infinito” do Meta
const PHONE_NUMBER_ID  = process.env.PHONE_NUMBER_ID;  // Phone Number ID
const VERIFY_TOKEN     = process.env.VERIFY_TOKEN || "hba-verify";

const GOOGLE_SA_EMAIL  = process.env.GOOGLE_SA_EMAIL;
const GOOGLE_SA_KEY    = (process.env.GOOGLE_SA_KEY || "").replace(/\\n/g, "\n");
const SHEETS_ID        = process.env.SHEETS_SPREADSHEET_ID;
const SHEETS_TAB       = process.env.SHEETS_TAB_NAME || "reservas";
const GDRIVE_FOLDER_ID = process.env.GDRIVE_FOLDER_ID;

const PORT = process.env.PORT || 10000;

// ====== APP ======
const app = express();
app.use(express.json());

// ====== GOOGLE (Sheets + Drive) ======
const gAuth = new google.auth.JWT(
  GOOGLE_SA_EMAIL,
  undefined,
  GOOGLE_SA_KEY,
  [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive"
  ]
);
const sheets = google.sheets({ version: "v4", auth: gAuth });
const drive  = google.drive({ version: "v3", auth: gAuth });

async function getSheetHeadersAndRows() {
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEETS_ID,
    range: `${SHEETS_TAB}!A:G`,
  });
  const [headers = [], ...rows] = data.values || [[]];
  return { headers, rows };
}
const colLetter = (i) => String.fromCharCode("A".charCodeAt(0) + i);

async function upsertBookingRow(patch) {
  const { headers, rows } = await getSheetHeadersAndRows();
  // cria headers se necessário
  if (headers.length === 0) {
    const defaultHeaders = ["booking_id","guest_phone","checkin_at_iso","docs_ok","docs_links","last_reminder","locker_code"];
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEETS_ID,
      range: `${SHEETS_TAB}!A1:G1`,
      valueInputOption: "RAW",
      requestBody: { values: [defaultHeaders] }
    });
    headers.push(...defaultHeaders);
  }

  const idx = rows.findIndex(r => r[ headers.indexOf("booking_id") ] === patch.booking_id);
  if (idx === -1) {
    // criar nova linha
    const line = headers.map(h => patch[h] ?? "");
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEETS_ID,
      range: `${SHEETS_TAB}!A:G`,
      valueInputOption: "RAW",
      requestBody: { values: [line] }
    });
    return;
  }

  // atualizar linha existente
  const rowNumber = idx + 2; // + header
  const updates = [];
  for (const [k,v] of Object.entries(patch)) {
    const c = headers.indexOf(k);
    if (c >= 0) {
      updates.push({ range: `${SHEETS_TAB}!${colLetter(c)}${rowNumber}`, values: [[String(v)]] });
    }
  }
  if (updates.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEETS_ID,
      requestBody: { data: updates, valueInputOption: "RAW" }
    });
  }
}

async function getBookingByPhone(phone) {
  const { headers, rows } = await getSheetHeadersAndRows();
  const phIdx = headers.indexOf("guest_phone");
  if (phIdx === -1) return null;
  const r = rows.find(r => (r[phIdx] || "") === phone);
  if (!r) return null;
  const obj = Object.fromEntries(headers.map((h,i)=>[h, r[i] || ""]));
  return obj;
}

// ====== WhatsApp helpers ======
const WA_BASE = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}`;
const WAH = { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } };

async function waSendText(to, body) {
  await axios.post(`${WA_BASE}/messages`, {
    messaging_product: "whatsapp",
    to, type: "text", text: { body }
  }, WAH);
}
async function waSendTemplate(to, name, components=[]) {
  await axios.post(`${WA_BASE}/messages`, {
    messaging_product: "whatsapp",
    to, type: "template",
    template: { name, language: { code: "pt" }, components }
  }, WAH);
}
async function getMediaUrl(mediaId) {
  const { data } = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, WAH);
  return data.url;
}
async function downloadMedia(url) {
  const res = await axios.get(url, { responseType: "arraybuffer", headers: WAH.headers });
  return { buffer: Buffer.from(res.data), contentType: res.headers["content-type"] || "application/octet-stream" };
}
async function uploadToDrive(buffer, name, mimeType) {
  const media = { mimeType, body: Buffer.from(buffer) };
  const meta  = { name, parents: [GDRIVE_FOLDER_ID] };
  const { data } = await drive.files.create({ requestBody: meta, media });
  // Opcional: tornar “qualquer pessoa com link pode ver”. Se não quiseres público, comenta estas 2 linhas.
  await drive.permissions.create({ fileId: data.id, requestBody: { role: "reader", type: "anyone" } });
  return `https://drive.google.com/file/d/${data.id}/view`;
}

// ====== HEALTH / VERIFY ======
app.get("/", (_,res)=>res.status(200).send("HBA WhatsApp bot ok"));
app.get("/healthz", (_,res)=>res.send("ok"));

app.get("/webhook", (req,res)=>{
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ====== WEBHOOK RECEIVE ======
app.post("/webhook", async (req,res)=>{
  try {
    const entry   = req.body.entry?.[0];
    const change  = entry?.changes?.[0];
    const value   = change?.value;
    const message = value?.messages?.[0];

    if (!message) return res.sendStatus(200); // status updates etc.

    const from = message.from; // telefone do hóspede

    if (message.type === "text") {
      // Mensagem simples → pedir documento
      await waSendText(from, "Olá! Envia uma foto do documento de identificação ou um PDF para concluirmos o check-in. Obrigado 🙌");
      return res.sendStatus(200);
    }

    // Receção de imagem ou PDF
    if (message.type === "image" || message.type === "document") {
      const mediaId   = message.image?.id || message.document?.id;
      const fileNameS = message.document?.filename || (message.type === "image" ? "documento.jpg" : "documento.bin");

      const url = await getMediaUrl(mediaId);
      const { buffer, contentType } = await downloadMedia(url);

      // extensão por content-type
      const ext = mime.extension(contentType) || "bin";
      const safeName = fileNameS.endsWith(`.${ext}`) ? fileNameS : `${fileNameS}.${ext}`;

      // upload para Drive
      const driveLink = await uploadToDrive(buffer, safeName, contentType);

      // tenta mapear booking pela coluna guest_phone
      const booking = await getBookingByPhone(from);
      if (booking) {
        // concat links se já existirem
        const newLinks = booking.docs_links ? `${booking.docs_links},${driveLink}` : driveLink;
        await upsertBookingRow({
          booking_id: booking.booking_id,
          docs_ok: "TRUE",
          docs_links: newLinks
        });
      }

      await waSendText(from, "Documento recebido ✅");
      return res.sendStatus(200);
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e?.response?.data || e.message);
    // devolve 200 para evitar reentregas repetidas pelo Meta
    res.sendStatus(200);
  }
});

// ====== ENDPOINT INTERNO: reserva confirmada (dispara pedido de doc e cria/atualiza linha) ======
app.post("/internal/booking-confirmed", async (req,res)=>{
  try {
    const { booking_id, guest_phone, checkin_at_iso } = req.body;
    if (!booking_id || !guest_phone) return res.status(400).json({ ok:false, error:"booking_id e guest_phone são obrigatórios" });

    await upsertBookingRow({
      booking_id,
      guest_phone,
      checkin_at_iso: checkin_at_iso || "",
      docs_ok: "FALSE",
      last_reminder: ""
    });

    await waSendTemplate(guest_phone, "request_document");
    return res.json({ ok:true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok:false, error: e.message });
  }
});

// ====== START ======
app.listen(PORT, () => {
  console.log(`Servidor a correr na porta ${PORT}`);
});
