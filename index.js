require('dotenv').config();
const express = require('express');
const Groq = require('groq-sdk');
const { Resend } = require('resend');

// --- CONFIGURACIÓN E INICIALIZACIÓN ---
const token = process.env.TELEGRAM_BOT_TOKEN;
const port = process.env.PORT || 3000;
const url = process.env.RENDER_EXTERNAL_URL;
const sheetdbUrl = process.env.SHEETDB_URL;

const app = express();
app.use(express.json());

const bot = new TelegramBot(token);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);

const userSessions = {}; 

const agencias = [
    { nombre: "Agencia CU (UNAM)", direccion: "Av. Insurgentes Sur 3000, Coyoacán" },
    { nombre: "Agencia Centro (CDMX)", direccion: "Av. Juárez 20, Centro Histórico" },
    { nombre: "Agencia Norte (Satélite)", direccion: "Cto. Centro Comercial 15, Naucalpan" }
];

// --- WEBHOOK Y SERVIDOR ---
if (url) {
    bot.setWebHook(`${url}/bot${token}`);
}

app.post(`/bot${token}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

app.get('/', (req, res) => res.send('AutoRent AI Server is Live!'));

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

// --- FUNCIONES DE RESPUESTA MODULARES ---

function enviarMenuPrincipal(chatId) {
    const mensaje = "👋 ¡Hola! Soy tu asistente virtual de *AutoRent AI*.\n\nEstoy aquí para ayudarte a encontrar el vehículo perfecto para ti. ¿Qué te gustaría hacer?";
    const opciones = {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: "🚘 Ver Catálogo de Autos", callback_data: "ver_catalogo" }],
                [{ text: "📍 Ubicación de Agencias", callback_data: "ver_agencias" }],
                [{ text: "📝 Reservar un Auto", callback_data: "iniciar_reserva" }]
            ]
        }
    };
    bot.sendMessage(chatId, mensaje, opciones);
}

async function mostrarCatalogo(chatId) {
    const autos = await obtenerCatalogoSheetDB();
    if (autos.length === 0) return bot.sendMessage(chatId, "No hay vehículos disponibles hoy.");
    
    let respuesta = "🚘 *Nuestro Catálogo Destacado:*\n\n";
    autos.forEach(a => respuesta += `• ${a.Marca} ${a.Modelo} - $${a.Precio_Por_Dia}/día\n`);
    bot.sendMessage(chatId, respuesta, { parse_mode: 'Markdown' });
}

function mostrarAgencias(chatId) {
    let msgAgencias = "📍 *Nuestras Sucursales:*\n\n";
    agencias.forEach(a => {
        msgAgencias += `• *${a.nombre}*\n  [Ver en Mapa](${generarLinkMaps(a.direccion)})\n\n`;
    });
    bot.sendMessage(chatId, msgAgencias, { parse_mode: 'Markdown', disable_web_page_preview: true });
}

function iniciarReserva(chatId) {
    userSessions[chatId] = { step: 'eligiendo_auto' };
    bot.sendMessage(chatId, "¡Perfecto! Vamos a armar tu reserva. 📝\n\n¿Qué marca y modelo de auto te gustaría rentar? (Ej. VW Jetta)");
}

// --- LÓGICA PRINCIPAL DEL BOT ---

bot.onText(/\/start/, (msg) => {
    enviarMenuPrincipal(msg.chat.id);
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text || text.startsWith('/')) return;

    if (userSessions[chatId]?.step === 'esperando_direccion') {
        userSessions[chatId].entrega = 'Entrega a Domicilio';
        userSessions[chatId].direccion = text;
        await finalizarReserva(chatId);
        return;
    }

    if (userSessions[chatId]?.step === 'eligiendo_auto') {
        userSessions[chatId].auto = text;
        userSessions[chatId].step = 'eligiendo_entrega';
        bot.sendMessage(chatId, "¡Excelente elección! 🚙\n\n¿Cómo prefieres recibir el vehículo?", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🏢 Recoger en Sucursal", callback_data: "sucursal" }],
                    [{ text: "🏠 Entrega a Domicilio", callback_data: "domicilio" }]
                ]
            }
        });
        return;
    }

    bot.sendChatAction(chatId, 'typing');
    try {
        const groqResponse = await groq.chat.completions.create({
            messages: [
                { 
                    role: "system", 
                    content: "Eres recepcionista de AutoRent. Clasifica la intención del usuario. Si saluda (hola, buenos dias, etc), responde 'SALUDO'. Si pide ver autos, responde 'CATALOGO'. Si pregunta por sucursales/ubicaciones, responde 'AGENCIAS'. Si quiere rentar/apartar, responde 'RESERVAR'. Si es otra cosa, responde natural y breve." 
                },
                { role: "user", content: text }
            ],
            model: "mixtral-8x7b-32768",
            temperature: 0.3,
        });

        const intent = groqResponse.choices[0].message.content.trim();

        if (intent.includes("SALUDO")) {
            enviarMenuPrincipal(chatId);
        } else if (intent.includes("CATALOGO")) {
            await mostrarCatalogo(chatId);
        } else if (intent.includes("AGENCIAS")) {
            mostrarAgencias(chatId);
        } else if (intent.includes("RESERVAR")) {
            iniciarReserva(chatId);
        } else {
            bot.sendMessage(chatId, intent);
        }
    } catch (error) {
        console.error("Error de Groq:", error);
    }
});

// --- MANEJO DE BOTONES (CALLBACKS) ---
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    // Responder a Telegram para quitar el icono de "cargando" en el botón
    bot.answerCallbackQuery(query.id);

    // Rutas del Menú Principal
    if (data === 'ver_catalogo') return mostrarCatalogo(chatId);
    if (data === 'ver_agencias') return mostrarAgencias(chatId);
    if (data === 'iniciar_reserva') return iniciarReserva(chatId);

    // Rutas del Flujo de Reserva
    if (data === 'sucursal') {
        let options = agencias.map((a, index) => [{ text: a.nombre, callback_data: `agencia_${index}` }]);
        bot.sendMessage(chatId, "Selecciona la sucursal donde recogerás el auto:", {
            reply_markup: { inline_keyboard: options }
        });
    } else if (data.startsWith('agencia_')) {
        const index = data.split('_')[1];
        const agenciaSeleccionada = agencias[index];
        
        userSessions[chatId].entrega = `Sucursal: ${agenciaSeleccionada.nombre}`;
        userSessions[chatId].direccion = agenciaSeleccionada.direccion;
        await finalizarReserva(chatId);

    } else if (data === 'domicilio') {
        userSessions[chatId].step = 'esperando_direccion';
        bot.sendMessage(chatId, "Por favor, escribe la dirección completa donde quieres que te entreguemos el auto:");
    }
});

// --- FINALIZACIÓN DE RESERVA Y NOTIFICACIONES ---
async function finalizarReserva(chatId) {
    const datos = userSessions[chatId];
    const mapLink = generarLinkMaps(datos.direccion);
    
    bot.sendMessage(chatId, "⏳ Procesando tu reserva...");

    const registroSheet = {
        Fecha: new Date().toLocaleString(),
        Auto: datos.auto,
        Metodo_Entrega: datos.entrega,
        Ubicacion: datos.direccion,
        Cliente_ChatID: chatId
    };
    await guardarReservaSheetDB(registroSheet);

    const comprobante = `✅ *¡Reserva Confirmada!*\n\n🚗 *Vehículo:* ${datos.auto}\n📦 *Método:* ${datos.entrega}\n📍 *Ubicación:* ${datos.direccion}\n\n🗺️ [Abrir ruta en Google Maps](${mapLink})`;
    await bot.sendMessage(chatId, comprobante, { parse_mode: 'Markdown', disable_web_page_preview: true });

    try {
        if (process.env.RESEND_API_KEY) {
            await resend.emails.send({
                from: 'AutoRent System <onboarding@resend.dev>',
                to: 'TU_CORREO_AQUI@gmail.com', // <--- CAMBIA ESTO
                subject: `Nueva Reserva: ${datos.auto}`,
                html: `<h2>Nueva Reserva Generada</h2><p><b>Auto:</b> ${datos.auto}</p><p><b>Entrega:</b> ${datos.entrega}</p><p><b>Dirección:</b> ${datos.direccion}</p><a href="${mapLink}">Ver en Mapa</a>`
            });
        }
    } catch (e) { console.error("No se pudo enviar el correo", e); }

    const waText = encodeURIComponent(`Hola, acabo de realizar una reserva.\nAuto: ${datos.auto}\nEntrega: ${datos.entrega}`);
    const waLink = `https://wa.me/525512345678?text=${waText}`; // <--- CAMBIA ESTO
    
    bot.sendMessage(chatId, `¿Necesitas enviar documentos o hablar con un asesor? 👇`, {
        reply_markup: { inline_keyboard: [[{ text: "💬 Hablar por WhatsApp", url: waLink }]] }
    });

    delete userSessions[chatId]; 
}

app.listen(port, () => console.log(`🚀 Servidor de AutoRent AI corriendo en el puerto ${port}`));
