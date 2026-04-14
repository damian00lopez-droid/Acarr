require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;
const sheetdbUrl = process.env.SHEETDB_URL;

// 🔹 Obtener autos desde Google Sheets (SheetDB)
async function obtenerAutos() {
    try {
        const res = await fetch(sheetdbUrl);
        const data = await res.json();
        // Filtramos solo los disponibles
        return data.filter(a => a.Disponibilidad === 'Disponible');
    } catch (error) {
        console.error("Error SheetDB:", error);
        return [];
    }
}

// 🔹 Guardar reserva en Google Sheets
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

// 🔹 Webhook Principal
app.post('/webhook', async (req, res) => {
    const queryResult = req.body.queryResult;
    const intent = queryResult.intent.displayName;
    const params = queryResult.parameters;
    const contexts = queryResult.outputContexts || [];

    // Función para recuperar parámetros de este intent o de contextos previos
    const getParam = (name) => {
        if (params[name] && params[name] !== "") return params[name];
        for (let c of contexts) {
            if (c.parameters && c.parameters[name]) return c.parameters[name];
        }
        return null;
    };

    console.log("Intent detectado:", intent);

    // ===============================
    // 👋 1. BIENVENIDA
    // ===============================
    if (intent === "Default Welcome Intent") {
        return res.json({
            fulfillmentText: "¡Hola! Bienvenido a AutoRent AI 🚗. ¿Buscas un auto para tu próximo viaje o salida? Puedo mostrarte los disponibles."
        });
    }

    // ===============================
    // 🚗 2. MOSTRAR AUTOS DISPONIBLES
    // ===============================
    if (intent === "Reserva") {
        const autos = await obtenerAutos();

        if (autos.length === 0) {
            return res.json({ fulfillmentText: "Lo siento, por el momento no tenemos autos disponibles. 😢" });
        }

        let msg = "🚗 Estos son los autos que tenemos para ti:\n\n";
        autos.slice(0, 3).forEach((a, i) => {
            msg += `${i + 1}️⃣ ${a.Marca} ${a.Modelo} - $${a.Precio_Por_Dia}/día\n`;
        });

        msg += "\n¿Cuál te gustaría elegir?";
        return res.json({ fulfillmentText: msg });
    }

    // ===============================
    // 💰 3. CALCULAR PRECIO (COTIZACIÓN)
    // ===============================
    if (intent === "Cotizacion.CalcularPrecio" || intent === "Reserva.SeleccionarVehiculo") {
        const modelo = getParam("modelo");
        const fInicio = getParam("Fecha_inicio");
        const fFin = getParam("Fecha_fin");

        // Si no tenemos fechas aún, solo confirmamos el modelo
        if (!fInicio || !fFin) {
            return res.json({
                fulfillmentText: `Excelente elección, el ${modelo} es un gran auto. ¿Para qué fecha lo necesitas? (Dime inicio y fin)`
            });
        }

        const fechaInicio = new Date(fInicio);
        const fechaFin = new Date(fFin);
        const dias = Math.max(1, Math.ceil((fechaFin - fechaInicio) / (1000 * 60 * 60 * 24)));

        const autos = await obtenerAutos();
        const auto = autos.find(a => (a.Modelo || "").toLowerCase().includes(modelo?.toLowerCase()));

        const precioDia = auto ? parseFloat(auto.Precio_Por_Dia) : 35;
        const total = precioDia * dias;

        return res.json({
            fulfillmentText: `💰 Tu renta por ${dias} día(s) para el ${modelo} sería de $${total}.\n\n¿Deseas agregar algún extra como GPS o Seguro?`
        });
    }

    // ===============================
    // ➕ 4. AGREGAR EXTRAS
    // ===============================
    if (intent === "Reserva.AgregarExtras") {
        const extra = getParam("extra") || "ninguno";
        let costoExtra = 0;

        if (extra.toLowerCase().includes("seguro")) costoExtra = 20;
        if (extra.toLowerCase().includes("gps")) costoExtra = 10;

        return res.json({
            fulfillmentText: `Perfecto, he añadido ${extra}. El costo adicional es de $${costoExtra}.\n\n¿Confirmamos tu reserva?`
        });
    }

    // ===============================
    // ✅ 5. CONFIRMAR Y GUARDAR
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
            Estado: "Pendiente",
            Timestamp: new Date().toLocaleString()
        });

        return res.json({
            fulfillmentText: `🎉 ¡Reserva confirmada con éxito!\n\n🚗 Auto: ${modelo}\n📅 Del ${fechaInicio} al ${fechaFin}\n🛠 Extras: ${extra}\n📄 Folio: ${folio}\n\n¡Gracias por confiar en AutoRent AI!`
        });
    }

    // ===============================
    // 🤖 FALLBACK (Si el intent no está mapeado arriba)
    // ===============================
    return res.json({
        fulfillmentText: "No estoy muy seguro de cómo ayudarte con eso. 😅 ¿Quieres que veamos los autos disponibles?"
    });

});

app.listen(port, () => console.log(`🚀 Servidor corriendo en el puerto ${port}`));
