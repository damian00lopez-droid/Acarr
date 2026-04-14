require('dotenv').config();
const express = require('express');
const { Resend } = require('resend');
const Groq = require('groq-sdk');

const port = process.env.PORT || 3000;
const sheetdbUrl = process.env.SHEETDB_URL;

const app = express();
app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const agencias = [
    { nombre: "Agencia CU (UNAM)", direccion: "Av. Insurgentes Sur 3000, Coyoacán" },
    { nombre: "Agencia Centro (CDMX)", direccion: "Av. Juárez 20, Centro Histórico" },
    { nombre: "Agencia Norte (Satélite)", direccion: "Cto. Centro Comercial 15, Naucalpan" }
];

// --- FUNCIONES DE APOYO ---
function generarLinkMaps(query) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

async function obtenerCatalogoSheetDB() {
    try {
        const response = await fetch(sheetdbUrl);
        const autos = await response.json();
        return autos.filter(auto => auto.Disponibilidad === 'Disponible').slice(0, 3);
    } catch (error) {
        console.error("Error consultando SheetDB:", error);
        return [];
    }
}

async function guardarReservaSheetDB(datos) {
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

// Función para conectar con la IA de Groq
async function consultarGroq(textoUsuario) {
    try {
        const groqResponse = await groq.chat.completions.create({
            messages: [
                { 
                    role: "system", 
                    content: "Eres un asistente amable de AutoRent AI, una empresa de renta de vehículos en CDMX y cerca de la UNAM. El usuario te está haciendo una pregunta fuera de lo común. Responde de manera servicial, breve (máximo 40 palabras) y natural." 
                },
                { role: "user", content: textoUsuario }
            ],
            model: "mixtral-8x7b-32768",
            temperature: 0.5, // Un poco más creativo para charla general
        });
        return groqResponse.choices[0].message.content.trim();
    } catch (error) {
        console.error("Error consultando a Groq:", error);
        return "Lo siento, tuve un pequeño problema procesando tu pregunta. ¿Podrías reformularla?";
    }
}

// --- RUTA EXCLUSIVA PARA DIALOGFLOW ---
app.post('/webhook', async (req, res) => {
    const intentName = req.body.queryResult.intent.displayName;
    const queryText = req.body.queryResult.queryText; // Lo que el usuario escribió realmente
    
    // Extraer parámetros
    let parameters = req.body.queryResult.parameters;
    const contexts = req.body.queryResult.outputContexts || [];
    
    const getContextParam = (paramName) => {
        if (parameters && parameters[paramName]) return parameters[paramName];
        for (let ctx of contexts) {
            if (ctx.parameters && ctx.parameters[paramName]) {
                return ctx.parameters[paramName];
            }
        }
        return 'No especificado';
    };

    console.log(`Ejecutando Intent: ${intentName}`);

    // LOGICA 1: CATÁLOGO
    if (intentName === 'Catalogo') {
        const autos = await obtenerCatalogoSheetDB();
        if (autos.length === 0) return res.json({ fulfillmentText: "En este momento no hay vehículos disponibles." });
        
        let respuesta = "🚘 *Catálogo AutoRent:*\n\n";
        autos.forEach(a => respuesta += `• ${a.Marca} ${a.Modelo} - $${a.Precio_Por_Dia}/día\n`);
        return res.json({ fulfillmentText: respuesta });
    }

    // LÓGICA 2: AGENCIAS
    if (intentName === 'Agencias') {
        let msgAgencias = "📍 *Nuestras Sucursales:*\n\n";
        agencias.forEach(a => msgAgencias += `• ${a.nombre}\n  Link de mapa: ${generarLinkMaps(a.direccion)}\n\n`);
        return res.json({ fulfillmentText: msgAgencias });
    }

    // LÓGICA 3: FINALIZAR RESERVA
    if (intentName === 'Finalizar_Sucursal' || intentName === 'Finalizar_Domicilio') {
        const autoElegido = getContextParam('auto');
        let metodoEntrega, direccionFinal;

        if (intentName === 'Finalizar_Sucursal') {
            metodoEntrega = "Recolección en Sucursal";
            direccionFinal = parameters.sucursal || getContextParam('sucursal'); 
        } else {
            metodoEntrega = "Entrega a Domicilio";
            direccionFinal = parameters.direccion || getContextParam('direccion');
        }

        const mapLink = generarLinkMaps(direccionFinal);

        await guardarReservaSheetDB({
            Fecha: new Date().toLocaleString(),
            Auto: autoElegido,
            Metodo_Entrega: metodoEntrega,
            Ubicacion: direccionFinal
        });

        // Correo de alerta
        try {
            if (process.env.RESEND_API_KEY) {
                await resend.emails.send({
                    from: 'AutoRent System <onboarding@resend.dev>',
                    to: 'TU_CORREO_AQUI@gmail.com', // <--- ACTUALIZA ESTO
                    subject: `Nueva Reserva: ${autoElegido}`,
                    html: `<h2>Nueva Reserva Generada</h2><p><b>Vehículo:</b> ${autoElegido}</p><p><b>Método:</b> ${metodoEntrega}</p><p><b>Dirección:</b> ${direccionFinal}</p>`
                });
            }
        } catch (e) { console.error("Error correo", e); }

        const waText = encodeURIComponent(`Hola, acabo de realizar una reserva del auto: ${autoElegido}.`);
        const waLink = `https://wa.me/525500000000?text=${waText}`;

        const respuestaFinal = `✅ *¡Tu reserva ha sido confirmada!*\n\n🚗 Vehículo: ${autoElegido}\n📦 Método: ${metodoEntrega}\n📍 Ubicación: ${direccionFinal}\n🗺️ Mapa: ${mapLink}\n\n💬 Soporte: ${waLink}`;
        
        return res.json({ fulfillmentText: respuestaFinal });
    }

    // --- EL CEREBRO DE IA (FALLBACK) ---
    // Si Dialogflow llega a su "Default Fallback Intent" (cuando no entiende al usuario)
    if (intentName === 'Default Fallback Intent') {
        console.log("Dialogflow no entendió. Consultando a Groq...");
        const respuestaIA = await consultarGroq(queryText);
        return res.json({ fulfillmentText: respuestaIA });
    }

    return res.json({ fulfillmentText: "Recibí la solicitud, pero no reconozco esta instrucción." });
});

app.listen(port, () => console.log(`🚀 Webhook con IA corriendo en el puerto ${port}`));
