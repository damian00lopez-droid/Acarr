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
        const r = await groq.chat.completions.create({
            messages: [
                {
                    role: "system",
                    content: "Eres un asistente amable de renta de autos en México. Responde claro, natural y profesional."
                },
                {
                    role: "user",
                    content: `Mejora este mensaje: "${base}". Contexto: ${contexto}`
                }
            ],
            model: "mixtral-8x7b-32768"
        });

        return r.choices[0].message.content;
    } catch {
        return base;
    }
}

// ===============================
// 🤖 IA GENERAL
// ===============================
async function consultarGroq(texto) {
    try {
        const r = await groq.chat.completions.create({
            messages: [
                { role: "system", content: "Eres un asistente de renta de autos." },
                { role: "user", content: texto }
            ],
            model: "mixtral-8x7b-32768"
        });

        return r.choices[0].message.content;
    } catch {
        return "No entendí bien 😅";
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
    await fetch(sheetdbUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: [datos] })
    });
}

// ===============================
// 🔹 BUSCAR RESERVA
// ===============================
async function buscarReserva(folio) {
    const res = await fetch(sheetdbUrl);
    const data = await res.json();
    return data.find(r => r.Folio === folio);
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
    // 👋 SALUDO GLOBAL
    // ===============================
    if (queryText.includes("hola") || queryText.includes("buenas")) {
        return res.json({
            fulfillmentText: "¡Hola! 👋 Soy AutoRent AI 🚗 ¿Te ayudo a encontrar un auto?"
        });
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

        return res.json({
            fulfillmentText: await mejorarRespuesta(
                `Autos disponibles:\n${lista}\n¿Cuál eliges?`,
                "mostrar autos"
            )
        });
    }

    // ===============================
    // 🚗 SELECCIÓN
    // ===============================
    if (intent === "Reserva.SeleccionarVehiculo") {
        const modelo = getParam("modelo");

        return res.json({
            fulfillmentText: await mejorarRespuesta(
                `Elegiste el ${modelo}. Ahora calcularé el precio.`,
                "selección"
            )
        });
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

        return res.json({
            fulfillmentText: await mejorarRespuesta(
                `Tu renta por ${dias} días cuesta $${total}. ¿Deseas agregar extras?`,
                "precio"
            )
        });
    }

    // ===============================
    // ➕ EXTRAS
    // ===============================
    if (intent === "Reserva.AgregarExtras") {
        const extra = getParam("extra") || "ninguno";

        let costo = 0;
        if (extra.includes("seguro")) costo = 20;
        if (extra.includes("gps")) costo = 10;

        return res.json({
            fulfillmentText: await mejorarRespuesta(
                `Agregué ${extra}. Costo extra $${costo}. ¿Confirmamos?`,
                "extras"
            )
        });
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
            Folio: folio,
            Estado: "Confirmado"
        });

        return res.json({
            fulfillmentText: await mejorarRespuesta(
                `Reserva confirmada. Auto: ${modelo}, fechas: ${fechaInicio} a ${fechaFin}, folio: ${folio}`,
                "confirmación"
            )
        });
    }

    // ===============================
    // ❌ CANCELAR
    // ===============================
    if (intent === "Cancelar_Reserva") {
        return res.json({
            fulfillmentText: "❌ Tu reserva ha sido cancelada."
        });
    }

    // ===============================
    // 🔍 CONSULTAR
    // ===============================
    if (intent === "RConsultar_Estado") {
        return res.json({
            fulfillmentText: "🔍 Indícame tu folio para consultar el estado."
        });
    }

    // ===============================
    // ✏️ MODIFICAR
    // ===============================
    if (intent === "RModificar") {
        return res.json({
            fulfillmentText: "✏️ Dime qué deseas modificar de tu reserva."
        });
    }

    // ===============================
    // ℹ️ INFO
    // ===============================
    if (intent === "Info_Requisitos") {
        return res.json({ fulfillmentText: "INE, licencia y tarjeta de crédito." });
    }

    if (intent === "Info_Precios_y_Disponibilidad") {
        return res.json({ fulfillmentText: "Desde $35 por día 🚗" });
    }

    if (intent === "Info_Seguros_y_Cobertura") {
        return res.json({ fulfillmentText: "Incluye seguro básico ✔" });
    }

    if (intent === "Info_Sucursales_y_Horarios") {
        return res.json({ fulfillmentText: "CDMX, horario 9am - 7pm" });
    }

    // ===============================
    // 🛠️ SOPORTE
    // ===============================
    if (intent === "Soporte") {
        return res.json({
            fulfillmentText: "📞 Puedes contactar soporte por WhatsApp."
        });
    }

    // ===============================
    // 🤖 IA FALLBACK
    // ===============================
    const respuestaIA = await consultarGroq(queryText);
    return res.json({ fulfillmentText: respuestaIA });

});

app.listen(port, () => console.log("🚀 Webhook completo funcionando"));
