require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const Groq = require('groq-sdk');
const nodemailer = require('nodemailer'); 

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;
const sheetdbUrl = process.env.SHEETDB_URL;
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const sesiones = new Map();

// ===============================
// 🔹 API DE WHATSAPP (ULTRAMSG)
// ===============================
async function enviarWhatsAppUltramsg(numero, mensaje) {
    const instanceId = process.env.ULTRAMSG_INSTANCE_ID;
    const token = process.env.ULTRAMSG_TOKEN;
    
    if (!instanceId || !token) {
        console.log("⚠️ Faltan credenciales de UltraMsg. Simulando mensaje a", numero);
        return;
    }

    const url = `https://api.ultramsg.com/${instanceId}/messages/chat`;
    const numeroLimpio = numero.replace(/\D/g, ''); 

    const params = new URLSearchParams();
    params.append("token", token);
    params.append("to", numeroLimpio);
    params.append("body", mensaje);

    try {
        await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params });
        console.log(`✅ WhatsApp enviado a ${numeroLimpio}`);
    } catch (error) {
        console.error("❌ Error enviando WhatsApp:", error);
    }
}

// ===============================
// 🔹 API DE CORREO (NODEMAILER)
// ===============================
async function enviarCorreoConfirmacion(correoDestino, asunto, texto) {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
        console.log("⚠️ Faltan credenciales SMTP. Simulando correo a", correoDestino);
        return;
    }

    let transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || "smtp.gmail.com",
        port: process.env.SMTP_PORT || 587,
        secure: false, 
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });

    try {
        await transporter.sendMail({ from: `"AutoRent" <${process.env.SMTP_USER}>`, to: correoDestino, subject: asunto, text: texto });
        console.log(`📧 Correo enviado a ${correoDestino}`);
    } catch (error) {
        console.error("❌ Error enviando correo:", error);
    }
}

// ===============================
// 🔹 FUNCIONES DE BASE DE DATOS
// ===============================
async function obtenerAutos() {
    try {
        const res = await fetch(sheetdbUrl);
        const data = await res.json();
        
        return data.filter(a => a.Disponibilidad === 'Disponible').map(a => ({
            Vehiculo: `${a.Marca} ${a.Modelo}`,
            Precio: a.Precio_Por_Dia,
            Puertas: a.Puertas || "4",
            Asientos: a.Asientos || "5",
            Transmision: a.Transmision || "Automatica",
            Imagen: a.Imagen || "" 
        }));
    } catch (error) {
        console.error("❌ Error consultando autos:", error);
        return [];
    }
}

async function guardarReserva(datos) {
    try {
        const urlDestino = `${sheetdbUrl}?sheet=Reservas`;
        await fetch(urlDestino, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: [datos] }) });
    } catch (error) {}
}

async function cancelarReserva(folio) {
    try {
        const urlDestino = `${sheetdbUrl}/Folio/${folio}?sheet=Reservas`;
        await fetch(urlDestino, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: { Estado: "Cancelado" } }) });
    } catch (error) {}
}

// ===============================
// 🚀 WEBHOOK IA ULTRA-OPTIMIZADO
// ===============================
app.post('/webhook', async (req, res) => {
    const queryText = req.body.queryResult?.queryText || "";
    const sessionId = req.body.session;
    
    console.log(`\n[Usuario] -> ${queryText}`);

    const autosDisponibles = await obtenerAutos();
    
    // 🔥 REDUCCIÓN DE TOKENS: Hacemos un resumen muy cortito del inventario para la IA
    const inventarioMini = autosDisponibles.map(a => `${a.Vehiculo} ($${a.Precio}) - ${a.Puertas}p, ${a.Asientos}a, ${a.Transmision}`).join(" | ");

    // 🔥 CEREBRO COMPACTO 🔥
    const promptSistema = `
    Eres AutoRent AI.
    Inventario disponible: ${inventarioMini}

    Reglas de flujo:
    1. RECOLECCIÓN: Al saludar, pide Nombre, Correo y Teléfono (WhatsApp). NO avances hasta tener los 3.
    2. PREFERENCIAS: Luego pregunta por preferencias: puertas, asientos y transmisión (Auto/Manual).
    3. RECOMENDACIÓN: Sugiere autos que cumplan las preferencias. Menciónalos por su nombre (ej. "Te sugiero el Nissan March").
    4. COTIZACIÓN: Pide fechas, calcula precio y ofrece extras.
    5. RESERVA: Genera folio aleatorio (ej. RES-8X2). Cambia "accion" a "guardar_reserva".
    6. CANCELAR: Pide folio, confirma y cambia "accion" a "cancelar_reserva".

    JSON OBLIGATORIO:
    {
        "respuesta_usuario": "Tu mensaje para el cliente.",
        "accion": "hablar", 
        "datos_cliente": { "Nombre": "", "Telefono": "", "Correo": "" },
        "datos_reserva": { "Modelo": "", "Fecha_inicio": "", "Fecha_fin": "", "Extras": "", "Folio": "" }
    }
    `;

    if (!sesiones.has(sessionId)) {
        sesiones.set(sessionId, [{ role: "system", content: promptSistema }]);
    }
    const historial = sesiones.get(sessionId);
    historial[0].content = promptSistema; 
    historial.push({ role: "user", content: queryText });

    // 🔥 EVITAR ERROR 429: Borramos historial viejo, mantenemos solo los últimos 5 mensajes
    if (historial.length > 5) {
        historial.splice(1, historial.length - 5); 
    }

    try {
        const respuestaGroq = await groq.chat.completions.create({
            messages: historial,
            model: "llama-3.1-8b-instant",
            response_format: { type: "json_object" },
            temperature: 0.3 
        });

        let contenidoIA = respuestaGroq.choices[0].message.content;
        contenidoIA = contenidoIA.replace(/```json/g, '').replace(/```/g, '').trim();
        const inicioJSON = contenidoIA.indexOf('{');
        const finJSON = contenidoIA.lastIndexOf('}') + 1;
        
        if(inicioJSON === -1 || finJSON === 0) throw new Error("No JSON");

        const jsonLimpio = contenidoIA.substring(inicioJSON, finJSON);
        const iaJSON = JSON.parse(jsonLimpio);
        
        // ========================================================
        // 🛠️ INYECCIÓN MÁGICA DE IMÁGENES Y MENÚ (SIN GASTAR TOKENS)
        // ========================================================
        let textoFinal = iaJSON.respuesta_usuario;

        // 1. Mostrar menú si dice hola o menú
        const queryMin = queryText.toLowerCase();
        if (queryMin.includes('hola') || queryMin.includes('menú') || queryMin.includes('menu')) {
            textoFinal += "\n\n¿En qué te puedo ayudar hoy?\n🚗 Rentar un auto\n❌ Cancelar reserva\n📋 Ver requisitos\n🎧 Soporte";
        }

        // 2. Si la IA mencionó el nombre de algún auto, nosotros inyectamos la foto y detalles
        let autosMencionados = autosDisponibles.filter(a => textoFinal.toLowerCase().includes(a.Vehiculo.toLowerCase()));
        
        // Si el cliente pide opciones y la IA le respondió recomendando autos...
        if (autosMencionados.length > 0 && !queryMin.includes('confirm')) {
            textoFinal += "\n\n🚗 *Aquí tienes los detalles de nuestras recomendaciones:*\n";
            autosMencionados.forEach(auto => {
                textoFinal += `\n🔹 *${auto.Vehiculo}* - $${auto.Precio}/día\nDetalles: ${auto.Puertas} ptas, ${auto.Asientos} asient, ${auto.Transmision}\n📸 Foto: ${auto.Imagen || "Sin imagen"}\n`;
            });
        }

        // 3. Menú al terminar trámites
        if (iaJSON.accion === "guardar_reserva" || iaJSON.accion === "cancelar_reserva") {
            textoFinal += "\n\n¿Deseas iniciar un nuevo trámite?\n🚗 Rentar un auto\n❌ Cancelar reserva\n📋 Ver requisitos\n🎧 Soporte";
        }

        // Guardamos en el historial lo que realmente dijimos
        iaJSON.respuesta_usuario = textoFinal; 
        historial.push({ role: "assistant", content: JSON.stringify(iaJSON) });

        // ========================================================
        // EJECUTAR ACCIONES FINALES Y APIS
        // ========================================================
        const nombreCliente = iaJSON.datos_cliente?.Nombre || "Cliente";
        const telefonoCliente = iaJSON.datos_cliente?.Telefono;
        const correoCliente = iaJSON.datos_cliente?.Correo;

        if (iaJSON.accion === "guardar_reserva") {
            console.log("⏳ Guardando reserva...");
            await guardarReserva({ Nombre: nombreCliente, Telefono: telefonoCliente, Correo: correoCliente, ...iaJSON.datos_reserva, Estado: "Confirmado" });

            if (telefonoCliente) {
                const msgWhatsapp = `🚗 *AutoRent* 🚗\n¡Hola ${nombreCliente}!\n\nReserva confirmada.\n*Modelo:* ${iaJSON.datos_reserva.Modelo}\n*Folio:* ${iaJSON.datos_reserva.Folio}\n*Fechas:* ${iaJSON.datos_reserva.Fecha_inicio} al ${iaJSON.datos_reserva.Fecha_fin}\n\n¡Gracias!`;
                await enviarWhatsAppUltramsg(telefonoCliente, msgWhatsapp);
            }
            if (correoCliente) {
                const asuntoCorreo = `Reserva AutoRent - Folio ${iaJSON.datos_reserva.Folio}`;
                const textoCorreo = `Hola ${nombreCliente},\n\nTu reserva del ${iaJSON.datos_reserva.Modelo} está confirmada.\nFechas: ${iaJSON.datos_reserva.Fecha_inicio} al ${iaJSON.datos_reserva.Fecha_fin}.\nFolio: ${iaJSON.datos_reserva.Folio}.\n\nSaludos.`;
                await enviarCorreoConfirmacion(correoCliente, asuntoCorreo, textoCorreo);
            }
        } else if (iaJSON.accion === "cancelar_reserva") {
            console.log(`⏳ Cancelando reserva...`);
            const folioMayusculas = (iaJSON.datos_reserva.Folio || "").toUpperCase();
            await cancelarReserva(folioMayusculas);

            if (telefonoCliente) {
                await enviarWhatsAppUltramsg(telefonoCliente, `🚫 *AutoRent* 🚫\nHola ${nombreCliente}. Tu reserva folio ${folioMayusculas} ha sido cancelada exitosamente.`);
            }
        }

        return res.json({ fulfillmentText: textoFinal });

    } catch (error) {
        console.error("❌ Error en webhook:", error.message || error);
        return res.json({
            fulfillmentText: "¡Uy! 😅 Tuve un pequeñísimo tropiezo de conexión (Rate Limit). ¿Podrías repetirme lo último?"
        });
    }
});

app.listen(port, () => console.log("🚀 Webhook IA Ultra-Optimizado funcionando en puerto", port));
