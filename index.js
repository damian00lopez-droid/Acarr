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
                    content: "Eres el asistente amigable de AutoRent AI. Responde de forma clara, natural, breve y persuasiva."
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
        return base; // Fallback al texto original si la IA falla
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
        console.error("Error guardando reserva:", e);
    }
}

// ===============================
// 🤖 IA FALLBACK (Para preguntas libres)
// ===============================
async function consultarGroq(texto) {
    try {
        const r = await groq.chat.completions.create({
            messages: [
                {
                    role: "system",
                    content: "Eres un asistente amable de renta de autos en México. Ayudas a los clientes con dudas generales sobre autos."
                },
                { role: "user", content: texto }
            ],
            model: "mixtral-8x7b-32768"
        });

        return r.choices[0].message.content;
    } catch {
        return "No entendí bien 😅 ¿puedes repetirlo o intentar de nuevo?";
    }
}

// ===============================
// 🚀 WEBHOOK PRINCIPAL
// ===============================
app.post('/webhook', async (req, res) => {
    const queryResult = req.body.queryResult;
    const intent = queryResult.intent.displayName;
    const params = queryResult.parameters;
    const contexts = queryResult.outputContexts || [];
    const queryText = queryResult.queryText;

    const getParam = (name) => {
        if (params[name] && params[name] !== "") return params[name];
        for (let c of contexts) {
            if (c.parameters && c.parameters[name]) return c.parameters[name];
        }
        return null;
    };

    console.log("Intent detectado:", intent);

    // ===============================
    // 👋 SALUDO INTELIGENTE (Default Welcome Intent)
    // ===============================
    if (intent === "Default Welcome Intent") {
        const msg = await mejorarRespuesta(
            "Hola 👋 soy AutoRent AI. Puedo ayudarte a rentar un auto, ver precios o disponibilidad.",
            "saludo inicial al cliente"
        );
        return res.json({ fulfillmentText: msg });
    }

    // ===============================
    // 🚗 MOSTRAR AUTOS (Texto IA + Imágenes)
    // ===============================
    if (intent === "Reserva") {
        const autos = await obtenerAutos();

        if (autos.length === 0) {
            const msg = await mejorarRespuesta("No hay autos disponibles por ahora.", "sin inventario");
            return res.json({ fulfillmentText: msg });
        }

        // 1. La IA genera un texto introductorio atractivo
        const introMsg = await mejorarRespuesta(
            "Aquí tienes nuestras mejores opciones de autos disponibles. ¿Cuál de estos te interesa?", 
            "mostrar catálogo de autos"
        );

        // 2. Creamos las tarjetas visuales (ESTO NO PASA POR LA IA PARA NO ROMPER EL JSON)
        const tarjetas = autos.slice(0, 5).map(a => ({
            card: {
                title: `${a.Marca} ${a.Modelo} (${a.Anio})`,
                subtitle: `💰 $${a.Precio_Por_Dia}/día • ${a.Transmision} • ${a.Capacidad_Pasajeros} pasajeros`,
                imageUri: a.Imagen_URL,
                buttons: [
                    {
                        text: `Elegir ${a.Modelo}`,
                        postback: `Quiero rentar el ${a.Modelo}`
                    }
                ]
            }
        }));

        // 3. Enviamos el texto de la IA combinado con las tarjetas
        return res.json({
            fulfillmentMessages: [
                { text: { text: [introMsg] } },
                ...tarjetas
            ]
        });
    }

    // ===============================
    // 🚗 SELECCIÓN DE VEHÍCULO
    // ===============================
    if (intent === "Reserva.SeleccionarVehiculo") {
        const modelo = getParam("modelo");
        const base = `Excelente, elegiste el ${modelo}. Dime tu fecha de inicio y fin para calcular el precio.`;
        const msg = await mejorarRespuesta(base, "vehículo seleccionado, pidiendo fechas");
        return res.json({ fulfillmentText: msg });
    }

    // ===============================
    // 💰 COTIZACIÓN / PRECIO
    // ===============================
    if (intent === "Cotizacion.CalcularPrecio") {
        const modelo = getParam("modelo");
        const fInicio = getParam("Fecha_inicio");
        const fFin = getParam("Fecha_fin");

        if (!fInicio || !fFin) {
            return res.json({ fulfillmentText: await mejorarRespuesta("Necesito las fechas exactas para darte el total.", "faltan fechas") });
        }

        const dias = Math.max(1, Math.ceil((new Date(fFin) - new Date(fInicio)) / (1000 * 60 * 60 * 24)));
        const autos = await obtenerAutos();
        const auto = autos.find(a => (a.Modelo || "").toLowerCase().includes(modelo?.toLowerCase()));

        const precio = auto ? parseFloat(auto.Precio_Por_Dia) : 35;
        const total = precio * dias;

        const base = `El costo total por ${dias} día(s) para el ${modelo} es $${total}. ¿Deseas agregar extras como GPS o Seguro?`;
        const msg = await mejorarRespuesta(base, "cotización calculada");

        return res.json({ fulfillmentText: msg });
    }

    // ===============================
    // ➕ AGREGAR EXTRAS
    // ===============================
    if (intent === "Reserva.AgregarExtras") {
        const extra = getParam("extra") || "ninguno";
        let costo = 0;
        
        if (extra.toLowerCase().includes("seguro")) costo = 20;
        if (extra.toLowerCase().includes("gps")) costo = 10;

        const base = `He agregado ${extra}. Esto suma $${costo} al total. ¿Confirmamos tu reserva?`;
        const msg = await mejorarRespuesta(base, "extras agregados");

        return res.json({ fulfillmentText: msg });
    }

    // ===============================
    // ✅ CONFIRMAR RESERVA
    // ===============================
    if (intent === "Reserva.Confirmar") {
        const modelo = getParam("modelo");
        const fechaInicio = getParam("Fecha_inicio");
        const fechaFin = getParam("Fecha_fin");
        const extra = getParam("extra") || "ninguno";
        const folio = "RES-" + Math.floor(1000 + Math.random() * 9000);

        await guardarReserva({
            Modelo: modelo,
            Fecha_inicio: fechaInicio,
            Fecha_fin: fechaFin,
            Extras: extra,
            Folio: folio,
            Estado: "Confirmada",
            Cliente: "Usuario Chatbot"
        });

        const base = `¡Reserva confirmada con éxito! Auto: ${modelo}, Del: ${fechaInicio} al ${fechaFin}. Tu folio es: ${folio}.`;
        const msg = await mejorarRespuesta(base, "confirmación de reserva exitosa");

        return res.json({ fulfillmentText: msg });
    }

    // ===============================
    // ℹ️ INFO REQUISITOS / PRECIOS
    // ===============================
    if (intent === "Info_Requisitos") {
        return res.json({ fulfillmentText: await mejorarRespuesta("Necesitas ser mayor de edad, INE, licencia vigente y tarjeta de crédito.", "requisitos de renta") });
    }

    if (intent === "Info_Precios_y_Disponibilidad") {
        return res.json({ fulfillmentText: await mejorarRespuesta("Los precios empiezan desde $35 por día dependiendo del modelo.", "información de precios") });
    }

    // ===============================
    // 🤖 FALLBACK IA (Para cualquier otra cosa)
    // ===============================
    // Si el intent no coincide con ninguno de los anteriores, o es el "Default Fallback Intent", se envía a Mixtral
    const respuestaIA = await consultarGroq(queryText);
    return res.json({ fulfillmentText: respuestaIA });

});

app.listen(port, () => console.log("🚀 Webhook Híbrido (IA + Tarjetas visuales) activo en puerto", port));
