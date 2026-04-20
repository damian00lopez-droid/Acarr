require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const Groq = require('groq-sdk');
const nodemailer = require('nodemailer'); // 🔥 REINTEGRADO PARA CORREOS

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
// 🔹 FUNCIONES DE CORREO
// ===============================
async function enviarCorreoConfirmacion(correoDestino, reserva, cliente, folio) {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
        console.log("⚠️ No se enviará correo: Credenciales SMTP no configuradas en .env");
        return false;
    }

    try {
        let transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST || "smtp.gmail.com",
            port: parseInt(process.env.SMTP_PORT) || 587,
            secure: false,
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            }
        });

        await transporter.sendMail({
            from: `"AutoRent" <${process.env.SMTP_USER}>`,
            to: correoDestino,
            subject: `🚗 Confirmación de Reserva - Folio: ${folio}`,
            text: `¡Hola ${cliente.nombre}!\n\nTu reserva ha sido confirmada exitosamente en nuestro sistema.\n\n🚗 Vehículo: ${reserva.vehiculo}\n📅 Fechas: ${reserva.fecha_inicio} al ${reserva.fecha_fin}\n📋 Folio de confirmación: ${folio}\n\n¡Gracias por elegir AutoRent! Un asesor se pondrá en contacto contigo para los detalles de entrega.`
        });
        console.log(`📧 Correo enviado a ${correoDestino}`);
        return true;
    } catch (error) {
        console.error("❌ Error enviando correo:", error);
        return false;
    }
}

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

function generarLink(preferencias = {}) {
    const params = new URLSearchParams();
    if (preferencias.tipo) params.append('tipo', preferencias.tipo);
    if (preferencias.marca) params.append('marca', preferencias.marca);
    if (preferencias.transmision) params.append('transmision', preferencias.transmision);
    
    const qs = params.toString();
    return qs ? `${CATALOGO_URL}?${qs}` : CATALOGO_URL;
}

// ===============================
// 🔹 PROMPT SISTEMA
// ===============================
function generarPromptSistema(autos) {
    const categoriasDisponibles = [...new Set(autos.map(a => a.tipo))].filter(Boolean).join(', ');

    return `Eres el asistente experto de AutoRent.

REGLAS DE ORO:
1. NO ENLISTES AUTOS: NUNCA menciones modelos específicos de autos (como Toyota Corolla o Honda Civic) por tu cuenta. Solo diles que revisen el catálogo.
2. PROHIBIDO INVENTAR FOLIOS.

PROCESO 1: RENTAR UN AUTO
- P1: Pregunta preferencias (Tipo de auto, manual/automático). Categorías: ${categoriasDisponibles}.
- P2: Pide Nombre, Correo y Teléfono.
- P3: Cuando tengas los datos, cambia tu accion a "recomendar". Diles "Te he preparado un catálogo personalizado basado en tus preferencias." (El sistema agregará el link). Diles que regresen a escribirte el nombre exacto del modelo que elijan.
- P4: Cuando te den el modelo exacto, pide las FECHAS.
- P5: Cuando tengas modelo y fechas, cambia accion a "guardar_reserva".

OTROS PROCESOS:
- Catálogo: Dile que puede ver los autos en la página.
- Cancelar: Pide su Folio. Cuando lo dé, cambia a "cancelar_reserva".
- Requisitos: INE/Pasaporte, Licencia vigente, Tarjeta de Crédito, mayor de 21 años.
- Soporte: Pide su teléfono para WhatsApp.

FORMATO JSON OBLIGATORIO:
{
  "respuesta_usuario": "Tu mensaje para el cliente...",
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
        const textoLimpio = queryText.toLowerCase().trim();
        const sessionId = req.body.session || `sess_${Date.now()}`;
        
        const autos = await obtenerAutos(); 
        const promptSistema = generarPromptSistema(autos);
        
        // 🔥 BYPASS DEL MENÚ INICIAL 🔥
        const palabrasMenu = ['hola', 'menú', 'menu', 'inicio', 'buenos dias', 'buenas tardes', 'buenas noches', 'opciones'];
        
        if (!sesiones.has(sessionId) || palabrasMenu.includes(textoLimpio)) {
            gestionarSesion(sessionId, promptSistema);
            let historial = sesiones.get(sessionId);

            const menuExacto = `¡Hola! Bienvenido a AutoRent 🚗. ¿Qué deseas hacer hoy?\n\n1️⃣ Rentar un Auto\n2️⃣ Ver Catálogo Completo\n3️⃣ Cancelar Reserva\n4️⃣ Requisitos para Rentar\n5️⃣ Soporte Técnico`;

            historial.push({ role: "user", content: queryText });
            historial.push({ 
                role: "assistant", 
                content: JSON.stringify({ respuesta_usuario: menuExacto, accion: "charlar", datos_cliente: {}, datos_reserva: {}, preferencias_detectadas: {} }) 
            });

            return res.json({ fulfillmentMessages: [{ text: { text: [menuExacto] } }] });
        }

        const historial = gestionarSesion(sessionId, promptSistema);
        historial.push({ role: "user", content: queryText });

        const completion = await groq.chat.completions.create({
            messages: historial,
            model: "llama-3.1-8b-instant",
            response_format: { type: "json_object" },
            temperature: 0.1
        });

        const respuestaIA = JSON.parse(completion.choices[0].message.content.trim());
        let respuestaFinal = respuestaIA.respuesta_usuario;

        // 🔥 RED DE SEGURIDAD 1: FORZAR EL LINK EN "RECOMENDAR" 🔥
        if (respuestaIA.accion === "recomendar") {
            const linkSeguro = generarLink(respuestaIA.preferencias_detectadas || {});
            // Aunque la IA no lo haya puesto, nosotros lo anexamos al final por fuerza bruta
            respuestaFinal += `\n\n🔗 *Revisa tu catálogo filtrado aquí:*\n${linkSeguro}\n\nCuando estés listo, regresa y dime el nombre del auto que quieres.`;
        }
        // Si no es recomendar, pero la IA puso [LINK_AQUI] por error, lo limpiamos o reemplazamos
        else if (respuestaFinal.includes("[LINK_AQUI]")) {
            respuestaFinal = respuestaFinal.replace("[LINK_AQUI]", CATALOGO_URL);
        }

        // 🔥 RED DE SEGURIDAD 2: FORZAR FOLIO Y ENVIAR CORREO EN "GUARDAR_RESERVA" 🔥
        if (respuestaIA.accion === "guardar_reserva") {
            const cliente = respuestaIA.datos_cliente || {};
            const reserva = respuestaIA.datos_reserva || {};
            
            if (cliente.nombre && reserva.vehiculo) {
                const folio = await guardarReservaEnExcel(cliente, reserva);
                if (folio) {
                    // Forzamos el folio en el texto final
                    respuestaFinal += `\n\n✅ ¡Reserva confirmada!\nTu folio es: *${folio}*\n\nTe hemos enviado los detalles a tu correo electrónico.`;
                    
                    // DISPARAR CORREO
                    if (cliente.correo) {
                        await enviarCorreoConfirmacion(cliente.correo, reserva, cliente, folio);
                    }

                    // Seguro Anti-Loop
                    historial.push({
                        role: "system",
                        content: "La reserva se guardó exitosamente. PROHIBIDO usar 'guardar_reserva' de nuevo. Cambia a 'charlar'."
                    });
                    respuestaIA.accion = "charlar"; 
                    respuestaIA.datos_reserva = {}; 
                } else {
                    respuestaFinal = "⚠️ Tuvimos un problema al generar el folio en la base de datos, un agente lo revisará pronto.";
                }
            } else {
                respuestaFinal = "Me faltó un dato. ¿Podrías confirmarme tu nombre, las fechas y el auto?";
                respuestaIA.accion = "charlar";
            }
        }

        // ACCIÓN: CANCELAR RESERVA
        if (respuestaIA.accion === "cancelar_reserva") {
            const folioACancelar = respuestaIA.datos_reserva?.folio_a_cancelar || "";
            
            if (folioACancelar.length >= 4) {
                const cancelado = await cancelarReservaEnExcel(folioACancelar);
                if (cancelado) {
                    respuestaFinal = `🚫 La reserva con folio *${folioACancelar}* ha sido cancelada exitosamente. ¿Necesitas algo más?`;
                } else {
                    respuestaFinal = `⚠️ No pudimos cancelar el folio ${folioACancelar}. Verifica que esté bien escrito.`;
                }
                historial.push({
                    role: "system",
                    content: "La cancelación se ejecutó. PROHIBIDO usar 'cancelar_reserva' de nuevo. Cambia a 'charlar'."
                });
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
        res.json({ fulfillmentText: "¡Hola! Bienvenido a AutoRent 🚗.\n\n1️⃣ Rentar un Auto\n2️⃣ Ver Catálogo\n3️⃣ Cancelar Reserva\n4️⃣ Requisitos\n5️⃣ Soporte" });
    }
});

app.listen(port, () => {
    console.log(`🚀 AutoRent Webhook corriendo en el puerto ${port}`);
});
