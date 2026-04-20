require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const Groq = require('groq-sdk');
const nodemailer = require('nodemailer');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const port = process.env.PORT || 3000;
const sheetdbUrl = process.env.SHEETDB_URL;

// ===============================
// 🔥 CONFIGURACIÓN
// ===============================
const CATALOGO_URL = process.env.CATALOGO_URL || "https://acarr-v3a2.onrender.com/catalogo.html";
const MAX_HISTORIAL = 8;

// ===============================
// 🔥 VALIDACIÓN API KEY GROQ
// ===============================
const RAW_KEY = process.env.GROQ_API_KEY || "";
const CLEAN_KEY = RAW_KEY.trim();

if (!CLEAN_KEY) {
    console.error("❌ ERROR: GROQ_API_KEY no encontrada");
    process.exit(1);
}

const groq = new Groq({ apiKey: CLEAN_KEY });
const sesiones = new Map();

// Cache de autos
let cacheAutos = {
    data: [],
    lastUpdate: null,
    ttl: 10 * 60 * 1000
};

// ===============================
// 🔹 CACHÉ DE AUTOS
// ===============================
async function obtenerAutos(forceRefresh = false) {
    try {
        if (!forceRefresh &&
            cacheAutos.data.length > 0 &&
            cacheAutos.lastUpdate &&
            (Date.now() - cacheAutos.lastUpdate) < cacheAutos.ttl) {
            return cacheAutos.data;
        }

        console.log("🔄 Actualizando catálogo...");
        const res = await fetch(sheetdbUrl);
        if (!res.ok) throw new Error(`SheetDB ${res.status}`);
        
        const data = await res.json();
        const autosProcesados = data
            .filter(a => a.Disponibilidad === 'Disponible' || a.Disponibilidad === 'DISPONIBLE')
            .map(a => ({
                marca: a.Marca || '',
                modelo: a.Modelo || '',
                vehiculo: `${a.Marca} ${a.Modelo}`,
                precio: parseFloat(a.Precio_Por_Dia) || 0,
                tipo: a.Categoria || a.Tipo || 'Sedan',
                transmision: a.Transmision || 'Automática'
            }));

        cacheAutos = {
            data: autosProcesados,
            lastUpdate: Date.now(),
            ttl: cacheAutos.ttl
        };

        return autosProcesados;
    } catch (error) {
        console.error("❌ Error catálogo:", error.message);
        return cacheAutos.data.length ? cacheAutos.data : [];
    }
}

// ===============================
// 🔹 GENERADOR DE LINK
// ===============================
function generarLink(preferencias = {}) {
    const params = new URLSearchParams();
    if (preferencias.tipo) params.append('tipo', preferencias.tipo);
    if (preferencias.marca) params.append('marca', preferencias.marca);
    if (preferencias.transmision) params.append('transmision', preferencias.transmision);
    
    const qs = params.toString();
    return qs ? `${CATALOGO_URL}?${qs}` : CATALOGO_URL;
}

// ===============================
// 🔹 GESTIÓN DE SESIONES & PROMPT
// ===============================
function generarPromptSistema(autos) {
    const resumenAutos = autos.slice(0, 10).map(a => `${a.vehiculo} (${a.tipo}, ${a.transmision}) a $${a.precio}`).join(', ');

    return `Eres el asistente virtual de AutoRent, amable y conversacional. Usa emojis.
Tu objetivo es averiguar qué busca el cliente y darle un enlace con recomendaciones.

Autos disponibles: ${resumenAutos} y más.
URL Base: ${CATALOGO_URL}

FLUJO:
1. Saluda y pregunta qué características busca (familiar, económico, automático, para carretera, etc.).
2. Haz recomendaciones basadas en sus respuestas.
3. Entrega el enlace con filtros. Si detectas un tipo o transmisión, genera la URL (ej. ${CATALOGO_URL}?tipo=SUV&transmision=Automatica).
4. No pidas que el usuario te diga qué auto quiere explícitamente, sugiere en base a sus gustos.

Responde SIEMPRE en formato JSON:
{
  "respuesta_usuario": "Tu mensaje amable con emojis e incluyendo el LINK final",
  "preferencias_detectadas": { "tipo": "", "transmision": "", "marca": "" }
}`;
}

function gestionarSesion(sessionId, promptSistema) {
    if (!sesiones.has(sessionId)) {
        sesiones.set(sessionId, [{ role: "system", content: promptSistema }]);
    }
    let historial = sesiones.get(sessionId);
    historial[0].content = promptSistema;
    
    if (historial.length > MAX_HISTORIAL) {
        historial = [historial[0], ...historial.slice(-MAX_HISTORIAL + 1)];
        sesiones.set(sessionId, historial);
    }
    return historial;
}

// ===============================
// 🚀 WEBHOOK PRINCIPAL (CON IA)
// ===============================
app.post('/webhook', async (req, res) => {
    try {
        const queryText = req.body.queryResult?.queryText || "";
        const sessionId = req.body.session || `sess_${Date.now()}`;
        
        const autos = await obtenerAutos();
        const promptSistema = generarPromptSistema(autos);
        const historial = gestionarSesion(sessionId, promptSistema);
        
        historial.push({ role: "user", content: queryText });

        const completion = await groq.chat.completions.create({
            messages: historial,
            model: "llama-3.1-8b-instant",
            response_format: { type: "json_object" },
            temperature: 0.5
        });

        const respuestaIA = JSON.parse(completion.choices[0].message.content.trim());
        let respuestaFinal = respuestaIA.respuesta_usuario;

        // Si la IA detectó preferencias, generamos el link nosotros para asegurar el formato correcto
        if (respuestaIA.preferencias_detectadas && Object.keys(respuestaIA.preferencias_detectadas).length > 0) {
            const linkSeguro = generarLink(respuestaIA.preferencias_detectadas);
            // Reemplazamos la URL base limpia por la que tiene parámetros, si la IA puso la URL en su texto
            respuestaFinal = respuestaFinal.replace(CATALOGO_URL, linkSeguro);
            
            // Si la IA olvidó poner el link, se lo forzamos al final
            if (!respuestaFinal.includes(CATALOGO_URL) && !respuestaFinal.includes('http')) {
                respuestaFinal += `\n\n🔗 Puedes ver las opciones que coinciden con lo que buscas aquí: ${linkSeguro}`;
            }
        }

        historial.push({ role: "assistant", content: JSON.stringify(respuestaIA) });

        res.json({
            fulfillmentMessages: [{ text: { text: [respuestaFinal] } }]
        });

    } catch (error) {
        console.error("❌ ERROR CRÍTICO EN WEBHOOK:", error);
        res.json({ fulfillmentText: "Lo siento, tuve un pequeño problema. ¿Me podrías repetir qué tipo de vehículo buscas?" });
    }
});

app.listen(port, () => {
    console.log(`🚀 AutoRent Webhook IA corriendo en el puerto ${port}`);
});
