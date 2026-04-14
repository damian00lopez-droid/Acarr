require('dotenv').config();
const express = require('express');
// Si usas Node.js 18+, puedes eliminar node-fetch. Si usas una versión anterior, déjalo.
const fetch = require('node-fetch'); 
const Groq = require('groq-sdk');

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;
const sheetdbUrl = process.env.SHEETDB_URL;

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ===============================
// 🤖 IA RESPUESTAS
// ===============================
async function mejorarRespuesta(base) {
    try {
        const r = await groq.chat.completions.create({
            messages: [
                { 
                    role: "system", 
                    content: "Eres un asistente amable de renta de autos. Tarea: Reescribe la siguiente respuesta para que suene natural. REGLA ESTRICTA: No inventes ni alteres modelos, precios, fechas ni folios proporcionados en el texto base." 
                },
                { role: "user", content: base }
            ],
            model: "mixtral-8x7b-32768"
        });

        return r.choices[0].message.content;
    } catch (error) {
        console.error("Error con Groq:", error);
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
    } catch (error) {
        console.error("Error obteniendo autos:", error);
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
        console.error("Error guardando en SheetDB:", error);
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
    const session = req.body.session; // ID de la sesión actual

    // Función auxiliar para buscar parámetros incluso dentro de contextos activos
    const getParam = (name) => {
        if (params && params[name]) return params[name];
        for (let c of contexts) {
            if (c.parameters && c.parameters[name]) return c.parameters[name];
        }
        return null;
    };

    // Función para crear contextos dinámicamente y controlar la "máquina de estados"
    const setContext = (name, lifespan, parameters = {}) => ({
        name: `${session}/contexts/${name}`,
        lifespanCount: lifespan,
        parameters: parameters
    });

    console.log(`[Intent Detectado] -> ${intent}`);

    // ===============================
    // 👋 SALUDO Y MENÚ PRINCIPAL
    // ===============================
    if (intent === "Default Welcome Intent") {
        return res.json({
            fulfillmentText: "¡Hola! 👋 Soy AutoRent AI. ¿Qué deseas hacer hoy?\n\n1️⃣ Rentar un auto 🚗\n2️⃣ Ver requisitos 📋\n3️⃣ Consultar precios 💰\n4️⃣ Hablar con soporte 🎧",
            // Forzamos un contexto inicial
            outputContexts: [setContext("menu-principal", 5)]
        });
    }

    // ===============================
    // 🚗 INICIAR RESERVA (Paso 1)
    // ===============================
    if (intent === "Reserva") {
        const autos = await obtenerAutos();

        if (!autos.length) {
            return res.json({ fulfillmentText: "Actualmente no tenemos autos disponibles 😢. Intenta más tarde." });
        }

        let lista = autos.slice(0, 3).map((a, i) =>
            `${i + 1}. ${a.Marca} ${a.Modelo} - $${a.Precio_Por_Dia}/día`
        ).join("\n");

        return res.json({
            fulfillmentText: await mejorarRespuesta(`Estos son los autos que tenemos disponibles:\n${lista}\n¿Qué modelo te gustaría elegir?`),
            // Abrimos la puerta al siguiente paso
            outputContexts: [setContext("esperando-vehiculo", 3)]
        });
    }

    // ===============================
    // 🚗 SELECCIÓN DE VEHÍCULO (Paso 2)
    // ===============================
    if (intent === "Reserva.SeleccionarVehiculo") {
        const modelo = getParam("modelo");

        return res.json({
            fulfillmentText: await mejorarRespuesta(`¡Excelente elección el ${modelo}! Para cotizar, dime: ¿En qué fecha inicia tu renta y en qué fecha termina?`),
            outputContexts: [setContext("vehiculo-seleccionado", 5, { modelo })]
        });
    }

    // ===============================
    // 💰 COTIZACIÓN / FECHAS (Paso 3)
    // ===============================
    if (intent === "Cotizacion.CalcularPrecio") {
        const modelo = getParam("modelo");
        const fInicioRaw = getParam("Fecha_inicio");
        const fFinRaw = getParam("Fecha_fin");

        if (!fInicioRaw || !fFinRaw) {
            return res.json({ fulfillmentText: "Por favor, indícame la fecha de inicio y la fecha de entrega del auto." });
        }

        const fInicio = new Date(fInicioRaw);
        const fFin = new Date(fFinRaw);
        const dias = Math.max(1, Math.ceil((fFin - fInicio) / (1000 * 60 * 60 * 24)));

        const autos = await obtenerAutos();
        const auto = autos.find(a => (a.Modelo || "").toLowerCase().includes(modelo?.toLowerCase()));
        
        const precio = auto ? parseFloat(auto.Precio_Por_Dia) : 35; // Valor por defecto en caso de no encontrarlo
        const total = precio * dias;

        return res.json({
            fulfillmentText: await mejorarRespuesta(`El costo total por ${dias} días de renta del ${modelo} es de $${total}. ¿Deseas agregar algún extra como GPS o seguro completo?`),
            outputContexts: [
                setContext("esperando-extras", 3, { total, dias })
            ]
        });
    }

    // ===============================
    // ➕ AGREGAR EXTRAS (Paso 4)
    // ===============================
    if (intent === "Reserva.AgregarExtras") {
        const extra = getParam("extra") || "ninguno";
        const modelo = getParam("modelo");

        let costoExtra = 0;
        if (extra.toLowerCase().includes("seguro")) costoExtra = 20;
        if (extra.toLowerCase().includes("gps")) costoExtra = 10;

        return res.json({
            fulfillmentText: await mejorarRespuesta(`Anotado, agregué ${extra} por $${costoExtra} adicionales. ¿Estás listo para confirmar tu reserva del ${modelo}?`),
            outputContexts: [setContext("listo-para-confirmar", 2, { extra, costoExtra })]
        });
    }

    // ===============================
    // ✅ CONFIRMAR RESERVA (Paso 5)
    // ===============================
    if (intent === "Reserva.Confirmar") {
        
        // Verificamos si el usuario llegó aquí siguiendo el flujo correcto
        const contextoConfirmar = contexts.find(c => c.name.includes("listo-para-confirmar") || c.name.includes("esperando-extras"));
        
        if (!contextoConfirmar) {
            return res.json({
                fulfillmentText: "⚠️ Parece que no hemos iniciado una reserva. Escribe 'Rentar un auto' para empezar."
            });
        }

        const modelo = getParam("modelo");
        const fechaInicio = getParam("Fecha_inicio");
        const fechaFin = getParam("Fecha_fin");
        const extra = getParam("extra") || "ninguno";

        if (!modelo || !fechaInicio || !fechaFin) {
            return res.json({ fulfillmentText: "⚠️ Me faltan algunos datos. Por favor, revisa las fechas y el modelo elegido." });
        }

        const folio = "RES-" + Math.floor(Math.random() * 10000);

        await guardarReserva({
            Modelo: modelo,
            Fecha_inicio: fechaInicio,
            Fecha_fin: fechaFin,
            Extras: extra,
            Folio: folio,
            Estado: "Confirmado"
        });

        // Limpieza de estados (Lifespan 0) para evitar que las variables se filtren a futuras reservas
        return res.json({
            fulfillmentText: await mejorarRespuesta(`¡Reserva confirmada con éxito! 🎉\nTu auto: ${modelo}\nFechas: ${fechaInicio.substring(0,10)} al ${fechaFin.substring(0,10)}\nTu número de folio es: ${folio}. ¡Gracias por preferirnos!`),
            outputContexts: [
                setContext("menu-principal", 0),
                setContext("esperando-vehiculo", 0),
                setContext("vehiculo-seleccionado", 0),
                setContext("esperando-extras", 0),
                setContext("listo-para-confirmar", 0)
            ]
        });
    }

    // ===============================
    // ℹ️ INTENTS INFORMATIVOS (Paralelos)
    // ===============================
    if (intent === "Info_Requisitos") {
        return res.json({ fulfillmentText: await mejorarRespuesta("Para rentar necesitas: Identificación oficial (INE/Pasaporte), licencia de conducir vigente y una tarjeta de crédito a tu nombre.") });
    }

    if (intent === "Info_Precios_y_Disponibilidad") {
        return res.json({ fulfillmentText: await mejorarRespuesta("Nuestros precios comienzan desde $35 USD por día, dependiendo del modelo y la temporada.") });
    }

    if (intent === "Info_Seguros_y_Cobertura") {
        return res.json({ fulfillmentText: await mejorarRespuesta("Todos los autos incluyen cobertura básica por daños a terceros. Puedes contratar cobertura amplia por $20 adicionales al día.") });
    }

    if (intent === "Info_Sucursales_y_Horarios") {
        return res.json({ fulfillmentText: await mejorarRespuesta("Nuestra sucursal principal está en la CDMX y abrimos de Lunes a Domingo, de 9:00 am a 7:00 pm.") });
    }

    // ===============================
    // 🤖 FALLBACK IA
    // ===============================
    // Si no coincide con nada, usamos Mixtral como comodín
    const respuestaIA = await mejorarRespuesta(`El usuario dijo: "${queryText}". Responde de forma amable indicando que no entendiste pero que puedes ayudar a rentar un auto.`);
    return res.json({ fulfillmentText: respuestaIA });

});

app.listen(port, () => console.log("🚀 Webhook con máquina de estados funcionando en el puerto", port));
