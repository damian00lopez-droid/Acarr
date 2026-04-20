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
// 🔥 CONFIGURACIÓN
// ===============================
const CATALOGO_URL = "https://acarr-v3a2.onrender.com/catalogo.html";
const MAX_HISTORIAL = 10; // Aumentamos un poco para no olvidar los datos del usuario

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
function generarPromptSistema(autos) {
    // Extraemos las categorías únicas para mostrarlas en el menú sin gastar muchos tokens
    const categoriasDisponibles = [...new Set(autos.map(a => a.tipo))].filter(Boolean).join(', ');

    return `Eres el asistente de AutoRent. Eres amable, profesional y usas emojis.
URL del catálogo: ${CATALOGO_URL}
Categorías disponibles hoy: ${categoriasDisponibles || 'Sedan, SUV, Familiar'}

FLUJO ESTRICTO DE ATENCIÓN:
PASO 1: Si el usuario saluda, dale la bienvenida y MUÉSTRALE LAS CATEGORÍAS DISPONIBLES de forma amigable (ej. "Tenemos modelos tipo Sedan, SUV..."). Pregúntale cuál prefiere.
PASO 2: Cuando el usuario elija un tipo de auto, dile que es una excelente elección. INMEDIATAMENTE pregúntale su Nombre, Correo Electrónico y Número de Teléfono para iniciar su proceso. No le des el enlace todavía.
PASO 3: Solo cuando el usuario te haya proporcionado su nombre, correo y teléfono, cambia la "accion" a "recomendar", agradécele, e invítalo a ver sus opciones en el enlace.

SIEMPRE responde en este formato JSON estricto:
{
  "respuesta_usuario": "Tu texto aquí...",
  "accion": "charlar" o "recomendar",
  "datos_cliente": { "nombre": "", "correo": "", "telefono": "" },
  "preferencias_detectadas": { "tipo": "", "transmision": "", "marca": "" }
}`;
}

function gestionarSesion(sessionId, promptSistema) {
    if (!sesiones.has(sessionId)) {
        sesiones.set(sessionId, [{ role: "system", content: promptSistema }]);
    }
    let historial = sesiones.get(sessionId);
    historial[0].content = promptSistema; // Actualiza el prompt con las categorías frescas
    
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
        
        // Obtenemos autos para extraer las categorías y pasarlas al prompt
        const autos = await obtenerAutos(); 
        
        const promptSistema = generarPromptSistema(autos);
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

        // SOLO agregamos el link si la IA decidió que ya tiene los datos y es momento de recomendar
        if (respuestaIA.accion === "recomendar") {
            const linkSeguro = generarLink(respuestaIA.preferencias_detectadas || {});
            
            // Reemplazo seguro o anexado del enlace
            if (respuestaFinal.includes(CATALOGO_URL)) {
                respuestaFinal = respuestaFinal.replace(CATALOGO_URL, linkSeguro);
            } else {
                respuestaFinal += `\n\n🔗 Puedes ver los modelos disponibles para ti aquí:\n${linkSeguro}`;
            }
        }

        historial.push({ role: "assistant", content: JSON.stringify(respuestaIA) });

        res.json({
            fulfillmentMessages: [{ text: { text: [respuestaFinal] } }]
        });

    } catch (error) {
        console.error("❌ ERROR CRÍTICO EN WEBHOOK:", error);
        res.json({ fulfillmentText: "¡Hola! Bienvenido a AutoRent 🚗. Estamos experimentando un pequeño retraso, ¿qué tipo de auto buscas?" });
    }
});

app.listen(port, () => {
    console.log(`🚀 AutoRent Webhook corriendo en el puerto ${port}`);
    console.log(`🔗 Catálogo configurado a: ${CATALOGO_URL}`);
});
