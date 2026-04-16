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
        console.log("⚠️ Credenciales de UltraMsg faltantes. Simulación enviada a:", numero);
        return;
    }

    const url = `https://api.ultramsg.com/${instanceId}/messages/chat`;
    const numeroLimpio = numero.replace(/\D/g, ''); 

    const params = new URLSearchParams();
    params.append("token", token);
    params.append("to", numeroLimpio);
    params.append("body", mensaje);

    try {
        await fetch(url, { method: 'POST', body: params });
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
        console.log("⚠️ Credenciales SMTP faltantes. Simulación de correo a:", correoDestino);
        return;
    }

    let transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || "smtp.gmail.com",
        port: process.env.SMTP_PORT || 587,
        secure: false, 
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });

    try {
        await transporter.sendMail({ 
            from: `"AutoRent Reservas" <${process.env.SMTP_USER}>`, 
            to: correoDestino, 
            subject: asunto, 
            text: texto 
        });
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
            ModeloSolo: a.Modelo,
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
        await fetch(urlDestino, { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ data: [datos] }) 
        });
    } catch (error) {
        console.error("❌ Error guardando reserva:", error);
    }
}

async function cancelarReserva(folio) {
    try {
        const urlDestino = `${sheetdbUrl}/Folio/${folio}?sheet=Reservas`;
        await fetch(urlDestino, { 
            method: 'PATCH', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ data: { Estado: "Cancelado" } }) 
        });
    } catch (error) {
        console.error("❌ Error cancelando reserva:", error);
    }
}

// ===============================
// 🚀 WEBHOOK IA OPTIMIZADO
// ===============================
app.post('/webhook', async (req, res) => {
    const queryText = req.body.queryResult?.queryText || "";
    const sessionId = req.body.session;
    
    console.log(`\n[Usuario] -> ${queryText}`);

    const autosDisponibles = await obtenerAutos();
    
    // 🧠 RESUMEN DE INVENTARIO: Gastamos menos memoria de la IA
    const inventarioMini = autosDisponibles.map(a => `${a.Vehiculo} ($${a.Precio}) - ${a.Puertas} ptas, ${a.Asientos} asient, ${a.Transmision}`).join(" | ");

    const promptSistema = `
    Eres AutoRent AI.
    Inventario disponible: ${inventarioMini}

    REGLAS DE FLUJO:
    1. OBLIGATORIO: Al saludar, pide Nombre, Correo y WhatsApp al usuario. No puedes avanzar al paso 2 hasta tener los 3 datos.
    2. PREFERENCIAS: Pregunta cuántas puertas, asientos y transmisión (Auto/Manual) prefiere.
    3. RECOMENDACIÓN: Sugiere autos del inventario según sus gustos. 
    4. COTIZACIÓN: Pide fechas, calcula precio total y ofrece extras (GPS $10, Seguro $20).
    5. RESERVA: Genera un folio dinámico (ej. RES-9P4M). Cambia "accion" a "guardar_reserva". Dile que recibirá confirmación por WhatsApp y Correo.
    6. CANCELAR: Pide su folio para cancelar, confirma y cambia "accion" a "cancelar_reserva".

    JSON OBLIGATORIO:
    {
        "respuesta_usuario": "Tu mensaje para el cliente. NUNCA incluyas links de imágenes aquí.",
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

    // 🔥 CONTROL DE MEMORIA: Borramos mensajes antiguos para no bloquear la IA (Error Limit Reached)
    if (historial.length > 7) {
        historial.splice(1, 2); 
    }

    try {
        const respuestaGroq = await groq.chat.completions.create({
            messages: historial,
            model: "llama-3.1-8b-instant",
            response_format: { type: "json_object" },
            temperature: 0.3 
        });

        let contenidoIA = respuestaGroq.choices[0].message.content;
        
        // Limpiamos la respuesta JSON
        contenidoIA = contenidoIA.replace(/```json/g, '').replace(/```/g, '').trim();
        const inicioJSON = contenidoIA.indexOf('{');
        const finJSON = contenidoIA.lastIndexOf('}') + 1;
        
        if(inicioJSON === -1 || finJSON === 0) throw new Error("Respuesta de IA sin JSON válido");

        const jsonLimpio = contenidoIA.substring(inicioJSON, finJSON);
        const iaJSON = JSON.parse(jsonLimpio);
        
        let textoFinal = iaJSON.respuesta_usuario;

        // ========================================================
        // 🛠️ INYECCIÓN AUTOMÁTICA DE IMÁGENES Y MENÚ (Lado del Servidor)
        // ========================================================
        
        const queryMin = queryText.toLowerCase();
        
        // 1. Mostrar menú inicial
        if (queryMin.includes('hola') || queryMin.includes('menu') || queryMin.includes('menú')) {
            textoFinal += "\n\n¿En qué te puedo ayudar hoy?\n🚗 Rentar un auto\n❌ Cancelar reserva\n📋 Ver requisitos\n🎧 Soporte";
        }

        // 2. Si el bot mencionó el nombre de algún auto, agregamos su foto de Telegram automáticamente
        let autosMencionados = autosDisponibles.filter(a => textoFinal.toLowerCase().includes(a.ModeloSolo.toLowerCase()));
        
        if (autosMencionados.length > 0 && iaJSON.accion === "hablar" && !textoFinal.toLowerCase().includes('confirm')) {
            textoFinal += "\n\n🚗 *Opciones para ti:*\n";
            autosMencionados.forEach(auto => {
                textoFinal += `\n🔹 *${auto.Vehiculo}* - $${auto.Precio}/día\n⚙️ ${auto.Transmision} | 🚪 ${auto.Puertas} ptas | 💺 ${auto.Asientos} asient.\n📸 Vista previa: ${auto.Imagen}\n`;
            });
        }

        // 3. Mostrar menú al terminar una acción
        if (iaJSON.accion === "guardar_reserva" || iaJSON.accion === "cancelar_reserva") {
            textoFinal += "\n\n¿Deseas iniciar un nuevo trámite?\n🚗 Rentar un auto\n❌ Cancelar reserva\n📋 Ver requisitos\n🎧 Soporte";
        }

        iaJSON.respuesta_usuario = textoFinal; 
        historial.push({ role: "assistant", content: JSON.stringify(iaJSON) });

        // ========================================================
        // EJECUCIÓN DE RESERVAS, WHATSAPP Y CORREO
        // ========================================================
        const nombreC = iaJSON.datos_cliente?.Nombre || "Cliente";
        const telefonoC = iaJSON.datos_cliente?.Telefono;
        const correoC = iaJSON.datos_cliente?.Correo;

        if (iaJSON.accion === "guardar_reserva") {
            console.log("⏳ Guardando reserva en Excel...");
            await guardarReserva({ Nombre: nombreC, Telefono: telefonoC, Correo: correoC, ...iaJSON.datos_reserva, Estado: "Confirmado" });

            if (telefonoC) {
                const msgW = `🚗 *AutoRent* 🚗\n¡Hola ${nombreC}!\nTu reserva de un ${iaJSON.datos_reserva.Modelo} está confirmada.\n*Folio:* ${iaJSON.datos_reserva.Folio}\n*Fechas:* ${iaJSON.datos_reserva.Fecha_inicio} al ${iaJSON.datos_reserva.Fecha_fin}\n¡Gracias por tu preferencia!`;
                await enviarWhatsAppUltramsg(telefonoC, msgW);
            }
            if (correoC) {
                const txtCorreo = `Hola ${nombreC},\n\nTu reserva del ${iaJSON.datos_reserva.Modelo} está confirmada.\nFechas: ${iaJSON.datos_reserva.Fecha_inicio} al ${iaJSON.datos_reserva.Fecha_fin}.\nFolio: ${iaJSON.datos_reserva.Folio}.\n\nSaludos del equipo de AutoRent.`;
                await enviarCorreoConfirmacion(correoC, `Confirmación de Reserva - Folio ${iaJSON.datos_reserva.Folio}`, txtCorreo);
            }
            
        } else if (iaJSON.accion === "cancelar_reserva") {
            console.log(`⏳ Cancelando reserva...`);
            const folioMayus = (iaJSON.datos_reserva.Folio || "").toUpperCase();
            await cancelarReserva(folioMayus);

            if (telefonoC) {
                await enviarWhatsAppUltramsg(telefonoC, `🚫 *AutoRent* 🚫\nHola ${nombreC}. Tu reserva folio ${folioMayus} ha sido cancelada exitosamente.`);
            }
        }

        return res.json({ fulfillmentText: textoFinal });

    } catch (error) {
        console.error("❌ Error en webhook:", error.message || error);
        return res.json({
            fulfillmentText: "¡Uy! 😅 Tuve un pequeñísimo problema de conexión. ¿Me podrías repetir tu último mensaje?"
        });
    }
});

app.listen(port, () => console.log("🚀 Webhook IA Optimizado funcionando en puerto", port));
