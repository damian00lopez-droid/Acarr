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
// 🔹 UTILIDAD RESPUESTA HUMANA
// ===============================
const responder = (titulo, mensaje = "") => ({
    fulfillmentText: `${titulo}\n\n${mensaje}`.trim()
});

// ===============================
// 🔹 OBTENER AUTOS
// ===============================
async function obtenerAutos() {
    try {
        const res = await fetch(sheetdbUrl);
        const data = await res.json();
        return data.filter(a => a.Disponibilidad === 'Disponible');
    } catch (error) {
        console.error("Error SheetDB:", error);
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
    } catch (error) {
        console.error("Error guardando reserva:", error);
    }
}

// ===============================
// 🤖 GROQ (IA)
// ===============================
async function consultarGroq(texto) {
    try {
        const response = await groq.chat.completions.create({
            messages: [
                {
                    role: "system",
                    content: "Eres un asistente amigable de renta de autos en México. Responde corto, claro y natural."
                },
                { role: "user", content: texto }
            ],
            model: "mixtral-8x7b-32768"
        });

        return response.choices[0].message.content;
    } catch (e) {
        return "No entendí muy bien 🤔 ¿puedes intentarlo de nuevo?";
    }
}

// ===============================
// 🚀 WEBHOOK
// ===============================
app.post('/webhook', async (req, res) => {

    const intent = req.body.queryResult.intent.displayName;
    const params = req.body.queryResult.parameters;
    const contexts = req.body.queryResult.outputContexts || [];
    const queryText = req.body.queryResult.queryText;

    const getParam = (name) => {
        if (params[name]) return params[name];
        for (let c of contexts) {
            if (c.parameters && c.parameters[name]) return c.parameters[name];
        }
        return null;
    };

    console.log("Intent:", intent);

    // ===============================
    // 🚗 RESERVA → MOSTRAR AUTOS
    // ===============================
    if (intent === "Reserva") {
        const autos = await obtenerAutos();

        if (!autos.length) {
            return res.json(responder(
                "😢 Lo siento",
                "Por el momento no hay autos disponibles."
            ));
        }

        let lista = autos.slice(0, 3).map((a, i) =>
            `${i + 1}. ${a.Marca} ${a.Modelo} - $${a.Precio_Por_Dia}/día`
        ).join("\n");

        return res.json(responder(
            "🚗 Autos disponibles",
            `${lista}\n\n¿Cuál te interesa?`
        ));
    }

    // ===============================
    // 🚗 SELECCIÓN
    // ===============================
    if (intent === "Reserva.SeleccionarVehiculo") {
        const modelo = getParam("modelo");

        return res.json(responder(
            "🙌 Excelente elección",
            `El ${modelo} es un gran auto 🚗\n\nAhora calcularé el precio para ti 💰`
        ));
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

        const precioDia = auto ? parseFloat(auto.Precio_Por_Dia) : 35;
        const total = precioDia * dias;

        return res.json(responder(
            "💰 Cotización lista",
            `Tu renta del *${modelo}* por ${dias} día(s) es de *$${total}*\n\n¿Quieres agregar extras como seguro o GPS?`
        ));
    }

    // ===============================
    // ➕ EXTRAS
    // ===============================
    if (intent === "Reserva.AgregarExtras") {
        const extra = getParam("extra") || "ninguno";

        let costo = 0;
        if (extra.includes("seguro")) costo = 20;
        if (extra.includes("gps")) costo = 10;

        return res.json(responder(
            "🔧 Extras agregados",
            `Añadí: ${extra} ✔\nCosto adicional: $${costo}\n\n¿Confirmamos tu reserva?`
        ));
    }

    // ===============================
    // ✅ CONFIRMAR
    // ===============================
    if (intent === "Reserva.Confirmar") {
        const modelo = getParam("modelo");
        const fechaInicio = getParam("Fecha_inicio");
        const fechaFin = getParam("Fecha_fin");
        const extra = getParam("extra") || "Ninguno";

        const folio = "RES-" + Math.floor(1000 + Math.random() * 9000);

        await guardarReserva({
            Modelo: modelo,
            Fecha_inicio: fechaInicio,
            Fecha_fin: fechaFin,
            Extras: extra,
            Folio: folio,
            Estado: "Confirmado",
            Fecha: new Date().toLocaleString()
        });

        return res.json(responder(
            "🎉 ¡Reserva confirmada!",
            `🚗 ${modelo}\n📅 ${fechaInicio} a ${fechaFin}\n🔧 Extras: ${extra}\n📄 Folio: ${folio}`
        ));
    }

    // ===============================
    // ℹ️ INFO
    // ===============================
    if (intent === "Info_Precios_y_Disponibilidad") {
        return res.json(responder(
            "💰 Precios",
            "Desde $35/día en autos básicos 🚗\nSUVs desde $85/día 🚙"
        ));
    }

    if (intent === "Info_Requisitos") {
        return res.json(responder(
            "📄 Requisitos",
            "✔ INE\n✔ Licencia vigente\n✔ Tarjeta de crédito"
        ));
    }

    if (intent === "Info_Seguros_y_Cobertura") {
        return res.json(responder(
            "🛡️ Seguro",
            "Incluye seguro básico ✔\nPuedes agregar cobertura premium 🔒"
        ));
    }

    if (intent === "Info_Sucursales_y_Horarios") {
        return res.json(responder(
            "📍 Sucursales",
            "CDMX y área metropolitana\n🕘 9:00 AM - 7:00 PM"
        ));
    }

    // ===============================
    // 🤖 IA FALLBACK
    // ===============================
    if (intent === "Default Fallback Intent") {
        const respuestaIA = await consultarGroq(queryText);
        return res.json(responder("🤖", respuestaIA));
    }

    return res.json(responder(
        "😅 No entendí",
        "¿Quieres ver autos disponibles?"
    ));
});

// ===============================
app.listen(port, () => console.log("🚀 Webhook listo"));
