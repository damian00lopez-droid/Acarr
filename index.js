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
const MAX_HISTORIAL = 14; 

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
        const folio = `AR-${Date.now().toString(36).toUpperCase()}`;
        
        const registro = {
            Nombre: cliente.nombre,
            Telefono: cliente.telefono || "No proporcionado",
            Correo: cliente.correo,
            Modelo: reserva.vehiculo,
            Fecha_Inicio: reserva.fecha_inicio,
            Fecha_Fin: reserva.fecha_fin,
            Extras: "", 
            Folio: folio,
            Estado: 'Confirmado'
        };

        const res = await fetch(`${sheetdbUrl}?sheet=Reservas`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: [registro] })
        });

        if (res.ok) return folio;
        return null;
    } catch (error) {
        console.error("❌ Error guardando en Excel:", error);
        return null;
    }
}

async function cancelarReservaEnExcel(folio) {
    try {
        const updateResponse = await fetch(`${sheetdbUrl}/Folio/${folio}?sheet=Reservas`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: { Estado: 'Cancelada' }
            })
        });
        return updateResponse.ok;
    } catch (error) {
        console.error('❌ Error cancelando reserva:', error);
        return false;
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
    const categoriasDisponibles = [...new Set(autos.map(a => a.tipo))].filter(Boolean).join(', ');

    return `Eres el asistente experto de AutoRent. Tu trabajo es guiar al cliente por nuestros procesos.

MENÚ PRINCIPAL OBLIGATORIO (Si te saludan o piden el menú, MUESTRA TEXTUALMENTE ESTO):
"¡Hola! Bienvenido a AutoRent 🚗. ¿Qué deseas hacer hoy?
1️⃣ Rentar un Auto
2️⃣ Ver Catálogo Completo
3️⃣ Cancelar Reserva
4️⃣ Requisitos para Rentar
5️⃣ Soporte Técnico"

PROCESO 1: RENTAR UN AUTO
- Paso 1: Pregunta sus preferencias (Tipo de auto, manual o automático, para cuántas personas). Las categorías hoy son: ${categoriasDisponibles}.
- Paso 2: Pide Nombre, Correo y Teléfono para su registro.
- Paso 3: Con sus datos, cambia tu acción a "recomendar". Dile que vea el enlace que generarás y te diga el MODELO EXACTO que desea.
- Paso 4: Pide las FECHAS (inicio y fin) para ese modelo.
- Paso 5: Cambia tu acción a "guardar_reserva". NUNCA repitas esta acción en turnos consecutivos.

OTROS PROCESOS:
- Catálogo (2): Solo diles que pueden ver los autos en el enlace base.
- Cancelar (3): Pide su Folio (ej. AR-12345). Cuando te lo den, cambia tu acción a "cancelar_reserva".
- Requisitos (4): Menciona: INE/Pasaporte, Licencia vigente, Tarjeta de Crédito y ser mayor de 21 años.
- Soporte (5): Pide su número para que un asesor le escriba por WhatsApp.

FORMATO JSON OBLIGATORIO PARA TODAS TUS RESPUESTAS:
{
  "respuesta_usuario": "Tu mensaje para el cliente (AQUÍ DEBE IR EL MENÚ SI ES EL INICIO)...",
  "accion": "charlar" | "recomendar" | "guardar_reserva" | "cancelar_reserva",
  "datos_cliente": { "nombre": "", "correo": "", "telefono": "" },
  "datos_reserva": { "vehiculo": "", "fecha_inicio": "", "fecha_fin": "", "folio_a_cancelar": "" },
  "preferencias_detectadas": { "tipo": "", "marca": "", "transmision": "" }
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
// 🚀 WEBHOOK PRINCIPAL
// ===============================
app.post('/webhook', async (req, res) => {
    try {
        const queryText = req.body.queryResult?.queryText || "";
        const sessionId = req.body.session || `sess_${Date.now()}`;
        
        const autos = await obtenerAutos(); 
        const promptSistema = generarPromptSistema(autos);
        const historial = gestionarSesion(sessionId, promptSistema);
        
        // 🔥 LA MAGIA ESTÁ AQUÍ: ORDEN ESTRICTA PARA EL PRIMER MENSAJE 🔥
        if (historial.length === 1) {
            historial.push({ 
                role: "system", 
                content: "OBLIGATORIO: Esta es tu primera respuesta al cliente. DEBES saludarlo y escribir textualmente la lista con las 5 opciones (1️⃣ Rentar, 2️⃣ Catálogo, etc.). No resumas el menú." 
            });
        }

        historial.push({ role: "user", content: queryText });

        const completion = await groq.chat.completions.create({
            messages: historial,
            model: "llama-3.1-8b-instant",
            response_format: { type: "json_object" },
            temperature: 0.2 // Bajamos la temperatura para que sea más obediente con las reglas
        });

        const respuestaIA = JSON.parse(completion.choices[0].message.content.trim());
        let respuestaFinal = respuestaIA.respuesta_usuario;

        // ACCIÓN: RECOMENDAR
        if (respuestaIA.accion === "recomendar") {
            const linkSeguro = generarLink(respuestaIA.preferencias_detectadas || {});
            if (respuestaFinal.includes(CATALOGO_URL)) {
                respuestaFinal = respuestaFinal.replace(CATALOGO_URL, linkSeguro);
            } else {
                respuestaFinal += `\n\n🔗 Aquí tienes opciones basadas en lo que buscas: ${linkSeguro}`;
            }
        }

        // ACCIÓN: GUARDAR RESERVA
        if (respuestaIA.accion === "guardar_reserva") {
            const cliente = respuestaIA.datos_cliente || {};
            const reserva = respuestaIA.datos_reserva || {};
            
            if (cliente.nombre && reserva.vehiculo) {
                const folio = await guardarReservaEnExcel(cliente, reserva);
                if (folio) {
                    respuestaFinal += `\n\n✅ ¡Hemos registrado tu reserva con éxito! Tu folio de confirmación es: *${folio}*.`;
                    respuestaIA.accion = "charlar"; 
                    respuestaIA.datos_reserva = {}; 
                } else {
                    respuestaFinal += `\n\n⚠️ Tuvimos un pequeño problema técnico, pero un agente verificará tus datos pronto.`;
                }
            } else {
                respuestaFinal = "Me faltó un dato. ¿Podrías confirmarme nuevamente tu nombre, las fechas y el auto?";
                respuestaIA.accion = "charlar";
            }
        }

        // ACCIÓN: CANCELAR RESERVA
        if (respuestaIA.accion === "cancelar_reserva") {
            const folioACancelar = respuestaIA.datos_reserva?.folio_a_cancelar || "";
            
            if (folioACancelar.length >= 4) {
                const cancelado = await cancelarReservaEnExcel(folioACancelar);
                if (cancelado) {
                    respuestaFinal += `\n\n🚫 La reserva con folio *${folioACancelar}* ha sido cancelada exitosamente.`;
                } else {
                    respuestaFinal += `\n\n⚠️ No pudimos cancelar el folio ${folioACancelar}. Verifica que esté bien escrito.`;
                }
                respuestaIA.accion = "charlar";
                respuestaIA.datos_reserva.folio_a_cancelar = "";
            } else {
                respuestaFinal = "Por favor, indícame un folio válido para cancelar (ejemplo: AR-1234X).";
            }
        }

        historial.push({ role: "assistant", content: JSON.stringify(respuestaIA) });

        res.json({
            fulfillmentMessages: [{ text: { text: [respuestaFinal] } }]
        });

    } catch (error) {
        console.error("❌ ERROR CRÍTICO EN WEBHOOK:", error);
        res.json({ fulfillmentText: "¡Hola! Bienvenido a AutoRent 🚗.\n\n1️⃣ Rentar un Auto\n2️⃣ Ver Catálogo\n3️⃣ Cancelar Reserva\n4️⃣ Requisitos\n5️⃣ Soporte\n\n¿En qué te ayudo hoy?" });
    }
});

app.listen(port, () => {
    console.log(`🚀 AutoRent Webhook corriendo en el puerto ${port}`);
});
