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
const MAX_HISTORIAL = 12; // Aumentado para que no olvide los datos del cliente

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
// 🔹 FUNCIONES DE BASE DE DATOS
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

async function guardarReservaEnExcel(cliente, reserva) {
    try {
        // Generamos un folio único
        const folio = `AR-${Date.now().toString(36).toUpperCase()}`;
        
        // Estructura de columnas que debe coincidir con tu Excel/SheetDB
        const registro = {
            Folio: folio,
            Fecha_Registro: new Date().toISOString().split('T')[0],
            Nombre_Cliente: cliente.nombre,
            Telefono: cliente.telefono,
            Correo: cliente.correo,
            Vehiculo_Elegido: reserva.vehiculo,
            Fecha_Inicio: reserva.fecha_inicio,
            Fecha_Fin: reserva.fecha_fin,
            Estado: 'Confirmada'
        };

        // Asumiendo que guardas en una pestaña llamada "Reservas". 
        // Si no tienes pestañas, quita "?sheet=Reservas"
        const res = await fetch(`${sheetdbUrl}?sheet=Reservas`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: [registro] })
        });

        if (res.ok) {
            console.log(`✅ Reserva guardada en Excel con Folio: ${folio}`);
            return folio;
        }
        return null;
    } catch (error) {
        console.error("❌ Error guardando en Excel:", error);
        return null;
    }
}

// ===============================
// 🔹 GENERADOR DE LINK
// ===============================
function generarLink(preferencias = {}) {
    const params = new URLSearchParams();
    if (preferencias.tipo) params.append('tipo', preferencias.tipo);
    if (preferencias.marca) params.append('marca', preferencias.marca);
    
    const qs = params.toString();
    return qs ? `${CATALOGO_URL}?${qs}` : CATALOGO_URL;
}

// ===============================
// 🔹 GESTIÓN DE SESIONES & PROMPT
// ===============================
function generarPromptSistema(autos) {
    const categoriasDisponibles = [...new Set(autos.map(a => a.tipo))].filter(Boolean).join(', ');

    return `Eres el asistente experto de AutoRent. Eres profesional, amigable y usas emojis.
URL del catálogo: ${CATALOGO_URL}
Categorías disponibles hoy: ${categoriasDisponibles || 'Sedan, SUV, Familiar'}

MENÚ DE PROCESOS (Debes guiar al cliente por estos pasos sutilmente):
PASO 1 - BIENVENIDA Y MENÚ: Saluda y ofrece nuestras opciones: 1) Rentar un Auto, 2) Ver Catálogo, 3) Soporte. Si quiere rentar, ofrécele las categorías.
PASO 2 - CAPTURA DE DATOS: Cuando elija una categoría, pídele su Nombre, Correo y Teléfono para su expediente.
PASO 3 - RECOMENDACIÓN (accion: recomendar): Una vez que tengas sus datos, envíale el enlace filtrado. MUY IMPORTANTE: Pídele que revise la página y regrese a decirte el MODELO EXACTO que desea.
PASO 4 - FECHAS (accion: solicitar_fechas): Cuando el cliente te diga qué modelo eligió (ej. "Quiero el Mazda 3"), felicítalo y pregúntale en qué FECHAS lo necesita (inicio y fin).
PASO 5 - GUARDAR RESERVA (accion: guardar_reserva): Cuando tengas el modelo y las fechas, confirma que todo está listo, agradécele y cambia tu acción a "guardar_reserva" para que el sistema lo registre.

FORMATO JSON OBLIGATORIO (No devuelvas texto fuera de este JSON):
{
  "respuesta_usuario": "Tu texto para el cliente...",
  "accion": "charlar" | "recomendar" | "solicitar_fechas" | "guardar_reserva",
  "datos_cliente": { "nombre": "", "correo": "", "telefono": "" },
  "datos_reserva": { "vehiculo": "", "fecha_inicio": "", "fecha_fin": "" },
  "preferencias_detectadas": { "tipo": "", "marca": "" }
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
            temperature: 0.3
        });

        const respuestaIA = JSON.parse(completion.choices[0].message.content.trim());
        let respuestaFinal = respuestaIA.respuesta_usuario;

        // ACCIÓN 1: RECOMENDAR (Insertar link dinámico)
        if (respuestaIA.accion === "recomendar") {
            const linkSeguro = generarLink(respuestaIA.preferencias_detectadas || {});
            if (respuestaFinal.includes(CATALOGO_URL)) {
                respuestaFinal = respuestaFinal.replace(CATALOGO_URL, linkSeguro);
            } else {
                respuestaFinal += `\n\n🔗 Aquí tienes tus opciones: ${linkSeguro}`;
            }
        }

        // ACCIÓN 2: GUARDAR RESERVA (Conectar con Excel/SheetDB)
        if (respuestaIA.accion === "guardar_reserva") {
            const cliente = respuestaIA.datos_cliente || {};
            const reserva = respuestaIA.datos_reserva || {};
            
            // Verificamos que al menos tengamos algo de información antes de guardar
            if (cliente.nombre && reserva.vehiculo) {
                const folio = await guardarReservaEnExcel(cliente, reserva);
                
                if (folio) {
                    respuestaFinal += `\n\n✅ ¡Hemos registrado tu reserva en nuestra base de datos con éxito! Tu folio de confirmación es: *${folio}*.`;
                } else {
                    respuestaFinal += `\n\n⚠️ Tuvimos un problema técnico al registrar tu reserva en el sistema, pero un agente se pondrá en contacto contigo pronto.`;
                }
            } else {
                respuestaFinal = "Parece que me faltó algún dato. ¿Me podrías confirmar nuevamente tu nombre y el auto que deseas?";
            }
        }

        historial.push({ role: "assistant", content: JSON.stringify(respuestaIA) });

        res.json({
            fulfillmentMessages: [{ text: { text: [respuestaFinal] } }]
        });

    } catch (error) {
        console.error("❌ ERROR CRÍTICO EN WEBHOOK:", error);
        res.json({ fulfillmentText: "¡Hola! Bienvenido a AutoRent 🚗. Nuestro menú principal es: 1) Rentar un auto. ¿En qué te ayudo?" });
    }
});

app.listen(port, () => {
    console.log(`🚀 AutoRent Webhook corriendo en el puerto ${port}`);
});
