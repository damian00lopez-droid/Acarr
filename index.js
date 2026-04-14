require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;
const sheetdbUrl = process.env.SHEETDB_URL;

// 🔹 Obtener autos desde Google Sheets
async function obtenerAutos() {
    try {
        const res = await fetch(sheetdbUrl);
        const data = await res.json();
        return data.filter(a => a.Disponibilidad === 'Disponible').slice(0, 3);
    } catch (error) {
        console.error("Error SheetDB:", error);
        return [];
    }
}

// 🔹 Guardar reserva
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

// 🔹 Webhook Dialogflow
app.post('/webhook', async (req, res) => {

    const intent = req.body.queryResult.intent.displayName;
    const params = req.body.queryResult.parameters;
    const contexts = req.body.queryResult.outputContexts || [];

    const getParam = (name) => {
        if (params[name]) return params[name];
        for (let c of contexts) {
            if (c.parameters[name]) return c.parameters[name];
        }
        return null;
    };

    console.log("Intent:", intent);

    // ===============================
    // 🚗 1. RESERVA → MOSTRAR AUTOS
    // ===============================
    if (intent === "Reserva") {
        const autos = await obtenerAutos();

        if (autos.length === 0) {
            return res.json({ fulfillmentText: "No hay autos disponibles 😢" });
        }

        let msg = "🚗 Autos disponibles:\n\n";
        autos.forEach((a, i) => {
            msg += `${i + 1}. ${a.Marca} ${a.Modelo} - $${a.Precio_Por_Dia}/día\n`;
        });

        msg += "\n¿Cuál deseas elegir?";
        return res.json({ fulfillmentText: msg });
    }

    // ===============================
    // 🚗 2. SELECCIONAR VEHÍCULO
    // ===============================
    if (intent === "Reserva.SeleccionarVehiculo") {
        const modelo = getParam("modelo");

        return res.json({
            fulfillmentText: `Perfecto 👍 elegiste el ${modelo}. Ahora calcularé el precio.`
        });
    }

    // ===============================
    // 💰 3. CALCULAR PRECIO
    // ===============================
    if (intent === "Cotizacion.CalcularPrecio") {

        const modelo = getParam("modelo");
        const fechaInicio = new Date(getParam("Fecha_inicio"));
        const fechaFin = new Date(getParam("Fecha_fin"));

        const dias = Math.ceil((fechaFin - fechaInicio) / (1000 * 60 * 60 * 24));

        const autos = await obtenerAutos();
        const auto = autos.find(a =>
            (a.Modelo || "").toLowerCase().includes(modelo?.toLowerCase())
        );

        const precio = auto ? parseFloat(auto.Precio_Por_Dia) : 35;
        const total = precio * dias;

        return res.json({
            fulfillmentText:
                `💰 Tu renta del ${fechaInicio.toDateString()} al ${fechaFin.toDateString()} ` +
                `(${dias} días) cuesta $${total}.\n\n¿Deseas agregar extras?`
        });
    }

    // ===============================
    // ➕ 4. AGREGAR EXTRAS
    // ===============================
    if (intent === "Reserva.AgregarExtras") {
        const extra = getParam("extra") || "ninguno";

        let costoExtra = 0;

        if (extra.includes("seguro")) costoExtra = 20;
        if (extra.includes("gps")) costoExtra = 10;

        return res.json({
            fulfillmentText:
                `Perfecto 👍 agregué: ${extra}.\n` +
                `Costo adicional: $${costoExtra} 💰\n\n¿Deseas confirmar tu reserva?`
        });
    }

    // ===============================
    // ✅ 5. CONFIRMAR RESERVA
    // ===============================
    if (intent === "Reserva.Confirmar") {

        const modelo = getParam("modelo");
        const fechaInicio = getParam("Fecha_inicio");
        const fechaFin = getParam("Fecha_fin");

        const folio = "RES-" + Math.floor(Math.random() * 10000);

        await guardarReserva({
            Modelo: modelo,
            Fecha_inicio: fechaInicio,
            Fecha_fin: fechaFin,
            Folio: folio
        });

        return res.json({
            fulfillmentText:
                `🎉 ¡Reserva confirmada!\n\n🚗 ${modelo}\n📅 ${fechaInicio} a ${fechaFin}\n📄 Folio: ${folio}`
        });
    }

    // ===============================
    // 🤖 FALLBACK
    // ===============================
    return res.json({
        fulfillmentText: "No entendí tu solicitud 😅 ¿puedes intentar de nuevo?"
    });

});

app.listen(port, () => console.log("🚀 Webhook corriendo"));
