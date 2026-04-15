require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const Groq = require('groq-sdk');
const nodemailer = require('nodemailer'); // NUEVO: Para enviar correos

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
    
    // Limpiamos el número por si el usuario puso espacios o guiones
    const numeroLimpio = numero.replace(/\D/g, ''); 

    const params = new URLSearchParams();
    params.append("token", token);
    params.append("to", numeroLimpio);
    params.append("body", mensaje);

    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params
        });
        console.log(`✅ WhatsApp enviado a ${numeroLimpio} vía UltraMsg`);
    } catch (error) {
        console.error("❌ Error enviando WhatsApp UltraMsg:", error);
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
        secure: false, // true para puerto 465, false para 587
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        }
    });

    try {
        await transporter.sendMail({
            from: `"AutoRent Reservas" <${process.env.SMTP_USER}>`,
            to: correoDestino,
            subject: asunto,
            text: texto
        });
        console.log(`📧 Correo enviado exitosamente a ${correoDestino}`);
    } catch (error) {
        console.error("❌ Error enviando correo con Nodemailer:", error);
    }
}

// ===============================
// 🔹 FUNCIONES DE BASE DE DATOS
// ===============================
async function obtenerAutos() {
    try {
        const res = await fetch(sheetdbUrl);
        const data = await res.json();
        
        // Ahora traemos más detalles para las preferencias e imágenes
        const autosListos = data
            .filter(a => a.Disponibilidad === 'Disponible')
            .map(a => ({
                Vehiculo: `${a.Marca} ${a.Modelo}`,
                Precio: a.Precio_Por_Dia,
                Puertas: a.Puertas || "4",
                Asientos: a.Asientos || "5",
                Transmision: a.Transmision || "Automatica",
                Imagen: a.Imagen || "" // Link de la imagen para Telegram
            }));
            
        return autosListos;
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
        console.log("✅ ¡Reserva guardada en el Excel!");
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
        console.log(`🚫 ¡Reserva ${folio} cancelada en el Excel!`);
    } catch (error) {
        console.error("❌ Error cancelando reserva:", error);
    }
}

// ===============================
// 🚀 WEBHOOK IA AVANZADO
// ===============================
app.post('/webhook', async (req, res) => {
    const queryText = req.body.queryResult?.queryText || "";
    const sessionId = req.body.session;
    
    console.log(`\n[Usuario] -> ${queryText}`);

    const autosDisponibles = await obtenerAutos();

    // 🔥 CEREBRO REPROGRAMADO PARA FILTROS, DATOS OBLIGATORIOS Y TELEGRAM 🔥
    const promptSistema = `
    Eres AutoRent AI, un asistente experto de renta de autos.

    INVENTARIO DISPONIBLE (CON DETALLES E IMÁGENES):
    ${JSON.stringify(autosDisponibles)}

    REGLAS ESTRICTAS DE FLUJO PASO A PASO (NO TE SALTES NINGUNO):

    PASO 1 (RECOLECCIÓN OBLIGATORIA DE DATOS): 
    Al iniciar la conversación, ESTÁ PROHIBIDO mostrar autos o cotizar. DEBES pedirle al usuario su Nombre, Correo Electrónico y Número de Teléfono (WhatsApp). 
    No avances al Paso 2 hasta que tengas esos 3 datos completos.

    PASO 2 (PREFERENCIAS): 
    Una vez que tengas su Nombre, Correo y Teléfono, pregúntale sus preferencias de viaje: ¿Cuántas puertas necesita?, ¿Cuántos asientos?, y ¿Qué transmisión prefiere (Automática o Manual)?.

    PASO 3 (MOSTRAR CATÁLOGO FILTRADO EN TELEGRAM): 
    Basado en sus preferencias, recomiéndale los autos que coincidan. 
    OBLIGATORIO: Cuando le describas un auto, dale la información completa (puertas, asientos, transmisión) y PON SIEMPRE LA URL DE LA IMAGEN en tu respuesta para que Telegram la pueda mostrar como vista previa. Ejemplo: "Te recomiendo el Nissan March ($400). Es automático, 5 asientos. Mira cómo luce: [URL_DE_LA_IMAGEN]".

    PASO 4 (COTIZACIÓN): 
    Pide fechas de inicio y fin. Calcula el total. Ofrece GPS ($10) o Seguro ($20).

    PASO 5 (CONFIRMACIÓN): 
    Si acepta, genera un FOLIO DINÁMICO único (Ej. RES-84K2P). 
    Dile textualmente: "Tu reserva está confirmada, [Nombre]. Tu folio es [FOLIO]. Te enviaremos un correo y un WhatsApp con los detalles.". Cambia la "accion" a "guardar_reserva".

    PASO 6 (CANCELAR RESERVA): 
    Si pide cancelar, solicítale su Folio. Al confirmar, cambia la "accion" a "cancelar_reserva" y dile: "Tu reserva con folio [FOLIO] ha sido cancelada exitosamente.".

    FORMATO JSON OBLIGATORIO:
    {
        "respuesta_usuario": "Tu mensaje de chat aquí. Recuerda incluir links de imágenes al mostrar autos.",
        "accion": "hablar", // Cambia a "guardar_reserva" o "cancelar_reserva" al finalizar
        "datos_cliente": {
            "Nombre": "",
            "Telefono": "",
            "Correo": ""
        },
        "datos_reserva": { 
            "Modelo": "",
            "Fecha_inicio": "",
            "Fecha_fin": "",
            "Extras": "",
            "Folio": ""
        }
    }
    `;

    if (!sesiones.has(sessionId)) {
        sesiones.set(sessionId, [{ role: "system", content: promptSistema }]);
    }
    const historial = sesiones.get(sessionId);

    historial[0].content = promptSistema; 
    historial.push({ role: "user", content: queryText });

    if (historial.length > 8) {
        historial.splice(1, historial.length - 8); // Damos un poco más de memoria para recolectar datos
    }

    try {
        const respuestaGroq = await groq.chat.completions.create({
            messages: historial,
            model: "llama-3.1-8b-instant",
            response_format: { type: "json_object" },
            temperature: 0.4 // Balance entre ser estricto siguiendo pasos y creativo con folios
        });

        let contenidoIA = respuestaGroq.choices[0].message.content;
        console.log(`[IA JSON Crudo] ->`, contenidoIA);

        // Limpieza de JSON
        contenidoIA = contenidoIA.replace(/```json/g, '').replace(/```/g, '').trim();
        const inicioJSON = contenidoIA.indexOf('{');
        const finJSON = contenidoIA.lastIndexOf('}') + 1;
        
        if(inicioJSON === -1 || finJSON === 0) {
            throw new Error("No se pudo extraer JSON de la respuesta.");
        }

        const jsonLimpio = contenidoIA.substring(inicioJSON, finJSON);
        const iaJSON = JSON.parse(jsonLimpio);
        
        historial.push({ role: "assistant", content: jsonLimpio });

        const nombreCliente = iaJSON.datos_cliente?.Nombre || "Cliente";
        const telefonoCliente = iaJSON.datos_cliente?.Telefono;
        const correoCliente = iaJSON.datos_cliente?.Correo;

        // EJECUTAR ACCIONES FINALES (RESERVAS Y CANCELACIONES)
        if (iaJSON.accion === "guardar_reserva") {
            console.log("⏳ Guardando reserva en SheetDB...");
            await guardarReserva({
                Nombre: nombreCliente,
                Telefono: telefonoCliente,
                Correo: correoCliente,
                ...iaJSON.datos_reserva,
                Estado: "Confirmado" 
            });

            // 🟢 DISPARAR WHATSAPP (ULTRAMSG)
            if (telefonoCliente) {
                const msgWhatsapp = `🚗 *AutoRent* 🚗\n¡Hola ${nombreCliente}!\n\nTu reserva ha sido confirmada con éxito.\n*Modelo:* ${iaJSON.datos_reserva.Modelo}\n*Folio:* ${iaJSON.datos_reserva.Folio}\n*Fechas:* ${iaJSON.datos_reserva.Fecha_inicio} al ${iaJSON.datos_reserva.Fecha_fin}\n\n¡Gracias por elegirnos!`;
                await enviarWhatsAppUltramsg(telefonoCliente, msgWhatsapp);
            }

            // 🟢 DISPARAR CORREO (NODEMAILER)
            if (correoCliente) {
                const asuntoCorreo = `Confirmación de Reserva AutoRent - Folio ${iaJSON.datos_reserva.Folio}`;
                const textoCorreo = `Hola ${nombreCliente},\n\nGracias por rentar con nosotros. Tu reserva del vehículo ${iaJSON.datos_reserva.Modelo} está confirmada.\n\nTus fechas son del ${iaJSON.datos_reserva.Fecha_inicio} al ${iaJSON.datos_reserva.Fecha_fin}.\nTu número de folio para cualquier aclaración es: ${iaJSON.datos_reserva.Folio}.\n\nSaludos,\nEl equipo de AutoRent`;
                await enviarCorreoConfirmacion(correoCliente, asuntoCorreo, textoCorreo);
            }

        } else if (iaJSON.accion === "cancelar_reserva") {
            console.log(`⏳ Cancelando reserva...`);
            const folioMayusculas = (iaJSON.datos_reserva.Folio || "").toUpperCase();
            await cancelarReserva(folioMayusculas);

            // 🟢 DISPARAR WHATSAPP DE CANCELACIÓN (ULTRAMSG)
            if (telefonoCliente) {
                const msgCancelacion = `🚫 *AutoRent* 🚫\nHola ${nombreCliente}. Te confirmamos que tu reserva con el folio ${folioMayusculas} ha sido cancelada exitosamente. Esperamos verte pronto.`;
                await enviarWhatsAppUltramsg(telefonoCliente, msgCancelacion);
            }
        }

        return res.json({
            fulfillmentText: iaJSON.respuesta_usuario
        });

    } catch (error) {
        console.error("❌ Error grave en webhook:", error.message || error);
        return res.json({
            fulfillmentText: "¡Uy! 😅 Tuve un pequeñísimo tropiezo técnico. ¿Serías tan amable de repetirme lo último que dijiste?"
        });
    }
});

app.listen(port, () => console.log("🚀 Webhook IA Avanzado funcionando en puerto", port));
