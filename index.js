require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const Groq = require('groq-sdk');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const port = process.env.PORT || 3000;
const sheetdbUrl = process.env.SHEETDB_URL;

// ===============================
// 🔥 CONFIGURACIÓN (URL FORZADA)
// ===============================
// Forzamos la URL correcta aquí para evitar que Render use una variable vieja
const CATALOGO_URL = "https://acarr-v3a2.onrender.com/catalogo.html";
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

let cacheAutos = {
    data: [],
    lastUpdate: null,
    ttl: 10 * 60 * 1000
};

// ===============================
// 🔹 CACHÉ DE AUTOS
// ===============================
async function obtenerAutos() {
    try {
        if (cacheAutos.data.length > 0 && cacheAutos.lastUpdate && (Date.now() - cacheAutos.lastUpdate) < cacheAutos.ttl) {
            return cacheAutos.data;
        }

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

        cacheAutos = { data: autosProcesados, lastUpdate: Date.now(), ttl: cacheAutos.ttl };
        return autosProcesados;
    } catch (error) {
        console.error("❌ Error catálogo:", error);
        return cacheAutos.data;
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
function generarPromptSistema() {
    return `Eres el asistente de AutoRent. Eres amable, conciso y usas emojis.
URL del catálogo: ${CATALOGO_URL}

REGLAS DE COMPORTAMIENTO:
1. SALUDO INICIAL: Si el usuario dice "hola" o es el primer contacto, responde con una bienvenida MUY CORTA. Ejemplo: "¡Hola! Bienvenido a AutoRent 🚗. ¿Qué tipo de vehículo estás buscando hoy?". NO hagas una lista larga de preguntas.
2. DESCUBRIMIENTO: Deja que el cliente te diga qué quiere (ej. familiar, económico, SUV, estándar).
3. RECOMENDACIÓN: Cuando el cliente ya te dio alguna preferencia, haz un comentario breve y cambia la "accion" a "recomendar" para entregarle el enlace.

SIEMPRE responde en este formato JSON estricto:
{
  "respuesta_usuario": "Tu texto aquí...",
  "accion": "charlar" o "recomendar",
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
        
        // Actualizamos caché en background, pero no le mandamos todos los autos a Groq para ahorrar tokens
        await obtenerAutos(); 
        
        const promptSistema = generarPromptSistema();
        const historial = gestionarSesion(sessionId, promptSistema);
        
        historial.push({ role: "user", content: queryText });

        const completion = await groq.chat.completions.create({
            messages: historial,
            model: "llama-3.1-8b-instant",
            response_format: { type: "json_object" },
            temperature: 0.3
        });

        const respuestaIA = JSON.parse(completion.choices[0].message.content.trim());
        let respuestaFinal = respuestaIA.respuesta_usuario;

        // SOLO agregamos el link si la IA decidió que ya es momento de recomendar
        if (respuestaIA.accion === "recomendar") {
            const linkSeguro = generarLink(respuestaIA.preferencias_detectadas || {});
            
            // Si la IA metió el enlace base en el texto, lo reemplazamos por el que tiene filtros
            if (respuestaFinal.includes(CATALOGO_URL)) {
                respuestaFinal = respuestaFinal.replace(CATALOGO_URL, linkSeguro);
            } else {
                // Si no lo puso, lo agregamos al final elegantemente
                respuestaFinal += `\n\n🔗 Puedes ver las opciones aquí:\n${linkSeguro}`;
            }
        }

        historial.push({ role: "assistant", content: JSON.stringify(respuestaIA) });

        res.json({
            fulfillmentMessages: [{ text: { text: [respuestaFinal] } }]
        });

    } catch (error) {
        console.error("❌ ERROR CRÍTICO EN WEBHOOK:", error);
        res.json({ fulfillmentText: "¡Hola! Bienvenido a AutoRent 🚗. ¿Qué tipo de auto estás buscando hoy?" });
    }
});

app.listen(port, () => {
    console.log(`🚀 AutoRent Webhook corriendo en el puerto ${port}`);
    console.log(`🔗 Catálogo configurado a: ${CATALOGO_URL}`);
});
