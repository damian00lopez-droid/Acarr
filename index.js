// Cargar variables de entorno (útil para pruebas locales)
require('dotenv').config();

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const Groq = require('groq-sdk');

// Variables de entorno
const token = process.env.TELEGRAM_BOT_TOKEN;
const port = process.env.PORT || 3000;
const url = process.env.RENDER_EXTERNAL_URL; 
const sheetdbUrl = process.env.SHEETDB_URL;

// Inicialización
const app = express();
app.use(express.json());
const bot = new TelegramBot(token);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Configurar Webhook para Render
if (url) {
    bot.setWebHook(`${url}/bot${token}`);
} else {
    console.log("Modo local: Asegúrate de tener un túnel (ej. ngrok) para recibir mensajes de Telegram.");
}

// Ruta para que Telegram envíe las actualizaciones
app.post(`/bot${token}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// Ruta raíz para verificar que el servidor está vivo
app.get('/', (req, res) => {
    res.send('Servidor del Bot de Rentas está activo y funcionando.');
});

// Función para conectar con tu Excel en SheetDB
async function obtenerCatalogoSheetDB() {
    try {
        const response = await fetch(sheetdbUrl);
        const autos = await response.json();
        // Filtramos solo los que dicen "Disponible"
        return autos.filter(auto => auto.Disponibilidad === 'Disponible');
    } catch (error) {
        console.error("Error consultando SheetDB:", error);
        return [];
    }
}

// Comando de inicio
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, "¡Hola! 🚗 Soy tu asistente virtual de rentas. Puedes pedirme ver los vehículos disponibles o preguntarme cómo funciona el servicio.");
});

// Procesamiento de lenguaje natural con Groq
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const textoUsuario = msg.text;

    // Ignorar comandos con barra para no duplicar respuestas
    if (!textoUsuario || textoUsuario.startsWith('/')) return;

    // Mostrar el estado "Escribiendo..." en Telegram
    bot.sendChatAction(chatId, 'typing');

    try {
        // 1. Enviar el mensaje a Groq para entender la intención
        const groqResponse = await groq.chat.completions.create({
            messages: [
                {
                    role: "system",
                    content: "Eres un asistente amable de una agencia de renta de autos. Si el usuario pide ver autos, opciones, catálogo, o rentar, responde EXACTAMENTE con la palabra: 'CATALOGO'. Si te preguntan otra cosa (saludos, dudas), responde amablemente en un máximo de 30 palabras."
                },
                {
                    role: "user",
                    content: textoUsuario
                }
            ],
            model: "mixtral-8x7b-32768", 
            temperature: 0.3,
        });

        const respuestaIA = groqResponse.choices[0]?.message?.content.trim();

        // 2. Si Groq determina que el usuario quiere ver los autos
        if (respuestaIA.includes("CATALOGO")) {
            bot.sendMessage(chatId, "⏳ Consultando nuestro inventario actual...");
            
            const autos = await obtenerCatalogoSheetDB();
            
            if (autos.length === 0) {
                bot.sendMessage(chatId, "Lo siento, en este momento no tenemos vehículos disponibles.");
                return;
            }

            // Mostramos un máximo de 3 autos para no saturar la pantalla de Telegram
            const autosMostrar = autos.slice(0, 3);
            
            for (const auto of autosMostrar) {
                const fichaTecnica = `*${auto.Marca} ${auto.Modelo} (${auto.Anio})*\n` +
                                     `💵 Precio: $${auto.Precio_Por_Dia}/día\n` +
                                     `⚙️ Transmisión: ${auto.Transmision}\n` +
                                     `⛽ Combustible: ${auto.Combustible}`;
                
                // Si hay URL de imagen, enviamos una tarjeta con foto. Si no, solo el texto.
                if (auto.Imagen_URL && auto.Imagen_URL.startsWith('http')) {
                    await bot.sendPhoto(chatId, auto.Imagen_URL, { caption: fichaTecnica, parse_mode: 'Markdown' });
                } else {
                    await bot.sendMessage(chatId, fichaTecnica, { parse_mode: 'Markdown' });
                }
            }
        } 
        // 3. Si es una duda general, enviar la respuesta generada por Groq
        else {
            bot.sendMessage(chatId, respuestaIA);
        }

    } catch (error) {
        console.error("Error general:", error);
        bot.sendMessage(chatId, "Tuve un pequeño problema técnico procesando tu solicitud. ¿Podrías intentar de nuevo?");
    }
});

// Iniciar el servidor Express
app.listen(port, () => {
    console.log(`🚀 Servidor ejecutándose en el puerto ${port}`);
});
