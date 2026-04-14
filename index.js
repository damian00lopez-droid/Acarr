require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const Groq = require('groq-sdk');

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;
const sheetdbUrl = process.env.SHEETDB_URL;

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ===============================
// 🤖 IA MEJORAR RESPUESTAS
// ===============================
async function mejorarRespuesta(base, contexto = "") {
    try {
        const response = await groq.chat.completions.create({
            messages: [
                {
                    role: "system",
                    content: "Eres un asistente amigable de renta de autos. Responde claro, natural y breve."
                },
                {
                    role: "user",
                    content: `Mejora este mensaje: "${base}". Contexto: ${contexto}`
                }
            ],
            model: "mixtral-8x7b-32768"
        });

        return response.choices[0].message.content;
    } catch {
        return base;
    }
}

// ===============================
// 🔹 OBTENER AUTOS
// ===============================
async function obtenerAutos() {
    try {
        const res = await fetch(sheetdbUrl);
        const data = await res.json();
        return data.filter(a => a.Disponibilidad === 'Disponible');
    } catch {
        return [];
    }
}

// ===============================
// 🔹 GUARDAR RESERVA
// ===============================
async function guardarReserva(datos) {
    try {
        await fetch(sheetdbUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: [datos] })
        });
    } catch (e) {
        console.error(e);
    }
}

// ===============================
// 🤖 IA FALLBACK
// ===============================
async function consultarGroq(texto) {
    try {
        const r = await groq.chat.completions.create({
            messages: [
                {
                    role: "system",
                    content: "Eres un asistente amable de renta de autos en México."
                },
                { role: "user", content: texto }
            ],
            model: "mixtral-8x7b-32768"
        });

        return r.choices[0].message.content;
    } catch {
        return "No entendí bien 😅 ¿puedes repetirlo?";
    }
}

// ===============================
// 🚀 WEBHOOK
// ===============================
app.post('/webhook', async (req, res) => {

    const intent = req.body.queryResult.intent.displayName;
    const params = req.body.queryResult.parameters;
    const contexts = req.body.queryResult.outputContexts || [];
    const queryText = req.body.queryResult.queryText.toLowerCase();

    const getParam = (name) => {
        if (params[name]) return params[name];
        for (let c of contexts) {
            if (c.parameters && c.parameters[name]) return c.parameters[name];
        }
        return null;
    };

    console.log("Intent:", intent);

    // ===============================
    // 👋 SALUDO INTELIGENTE
    // ===============================
    if (queryText.includes("hola") || queryText.includes("buenas")) {
        const msg = await mejorarRespuesta(
            "Hola 👋 soy AutoRent AI. Puedo ayudarte a rentar un auto, ver precios o disponibilidad.",
            "saludo inicial"
        );
        return res.json({ fulfillmentText: msg });
    }

    // ===============================
    // 🚗 RESERVA
    // ===============================
    if (intent === "Reserva") {
        const autos = await obtenerAutos();

        if (!autos.length) {
            return res.json({ fulfillmentText: "No hay autos disponibles 😢" });
        }

        let lista = autos.slice(0, 3).map((a, i) =>
            `${i + 1}. ${a.Marca} ${a.Modelo} - $${a.Precio_Por_Dia}/día`
        ).join("\n");

        const base = `Autos disponibles:\n${lista}\n¿Cuál te interesa?`;
        const msg = await mejorarRespuesta(base, "mostrar autos");

        return res.json({ fulfillmentText: msg });
    }

    // ===============================
    // 🚗 SELECCIÓN
    // ===============================
    if (intent === "Reserva.SeleccionarVehiculo") {
        const modelo = getParam("modelo");

        const base = `Elegiste el ${modelo}. Ahora calcularé el precio.`;
        const msg = await mejorarRespuesta(base, "selección de auto");

        return res.json({ fulfillmentText: msg });
    }

    // ===============================
    // 💰 PRECIO
    // ===============================
    if (intent === "Cotizacion.CalcularPrecio") {
        const modelo = getParam("modelo");
        const fInicio = new Date(getParam("Fecha_inicio"));
        const fFin = new Date(getParam("Fecha_fin"));

        const dias = Math.max(1, Math.ceil((fFin - fInicio) / (1000 * 60 * 60 * 24)));

        const autos = await obtenerAutos();
        const auto = autos.find(a =>
            (a.Modelo || "").toLowerCase().includes(modelo?.toLowerCase())
        );

        const precio = auto ? parseFloat(auto.Precio_Por_Dia) : 35;
        const total = precio * dias;

        const base = `Tu renta por ${dias} días del ${modelo} cuesta $${total}. ¿Quieres agregar extras?`;
        const msg = await mejorarRespuesta(base, "cotización");

        return res.json({ fulfillmentText: msg });
    }

    // ===============================
    // ➕ EXTRAS
    // ===============================
    if (intent === "Reserva.AgregarExtras") {
        const extra = getParam("extra") || "ninguno";

        let costo = 0;
        if (extra.includes("seguro")) costo = 20;
        if (extra.includes("gps")) costo = 10;

        const base = `Agregué ${extra}. Costo adicional $${costo}. ¿Confirmamos?`;
        const msg = await mejorarRespuesta(base, "extras");

        return res.json({ fulfillmentText: msg });
    }

    // ===============================
    // ✅ CONFIRMAR
    // ===============================
    if (intent === "Reserva.Confirmar") {

        const modelo = getParam("modelo");
        const fechaInicio = getParam("Fecha_inicio");
        const fechaFin = getParam("Fecha_fin");
        const extra = getParam("extra") || "ninguno";

        const folio = "RES-" + Math.floor(Math.random() * 10000);

        await guardarReserva({
            Modelo: modelo,
            Fecha_inicio: fechaInicio,
            Fecha_fin: fechaFin,
            Extras: extra,
            Folio: folio
        });

        const base = `Reserva confirmada. Auto: ${modelo}, fechas: ${fechaInicio} a ${fechaFin}, folio: ${folio}`;
        const msg = await mejorarRespuesta(base, "confirmación");

        return res.json({ fulfillmentText: msg });
    }

    // ===============================
    // ℹ️ INFO
    // ===============================
    if (intent === "Info_Requisitos") {
        return res.json({ fulfillmentText: await mejorarRespuesta(
            "Necesitas INE, licencia y tarjeta de crédito.",
            "requisitos"
        )});
    }

    if (intent === "Info_Precios_y_Disponibilidad") {
        return res.json({ fulfillmentText: await mejorarRespuesta(
            "Los precios empiezan desde $35 por día.",
            "precios"
        )});
    }

    // ===============================
    // 🤖 FALLBACK IA
    // ===============================
    const respuestaIA = await consultarGroq(queryText);
    return res.json({ fulfillmentText: respuestaIA });

});

app.listen(port, () => console.log("🚀 Webhook con IA listo"));
