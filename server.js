// server.js
import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// ⚙️ Variáveis de ambiente (vamos defini-las no Render)
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;     // token permanente/60d do Meta
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;   // API Setup -> Phone number ID
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "hba_verify"; // o mesmo que vais pôr no Meta

// endpoint de saúde
app.get("/", (_req, res) => res.status(200).send("HBA WhatsApp bot ok"));
app.get("/healthz", (_req, res) => res.send("ok"));

// ✅ Verificação do Webhook (paso no Meta → Webhooks)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// 📩 Recebe mensagens do WhatsApp
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // mensagens novas (ignore status, etc.)
    const msg = value?.messages?.[0];
    if (msg) {
      const from = msg.from;
      const text =
        msg.text?.body ||
        msg.interactive?.list_reply?.title ||
        msg.interactive?.button_reply?.title ||
        "(sem texto)";

      console.log("📩 Mensagem recebida:", text, "de", from);

      await sendText(from, `Olá 👋, recebemos a tua mensagem: "${text}". Já estamos a tratar!`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Erro a processar webhook:", err.response?.data || err.message);
    res.sendStatus(200); // devolvemos 200 para o Meta não voltar a reenviar
  }
});

// 📨 helper para enviar texto
async function sendText(to, body) {
  const url = `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`;
  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to,
      text: { body },
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server a correr na porta ${PORT}`));
