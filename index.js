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
        secure: false, 
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
        
        const autosListos = data
            .filter(a => a.Disponibilidad === 'Disponible')
            .map(a => ({
                Vehiculo: `${a.Marca} ${a.Modelo}`,
                Precio: a.Precio_Por_Dia,
                Puertas: a.Puertas || "4",
                Asientos: a.Asientos || "5",
                Transmision: a.Transmision || "Automatica",
                Imagen: a.Imagen || "" 
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
// 🚀 WEBHOOK IA DEFINITIVO
// ===============================
app.post('/webhook', async (req, res) => {
    const queryText = req.body.queryResult?.queryText || "";
    const sessionId = req.body.session;
    
    console.log(`\n[Usuario] -> ${queryText}`);

    const autosDisponibles = await obtenerAutos();

    // 🔥 CEREBRO ANTI-PEREZA Y OBLIGACIÓN DE FORMATO 🔥
    const promptSistema = `
    Eres AutoRent AI, un asistente experto de renta de autos.

    INVENTARIO DISPONIBLE:
    ${JSON.stringify(autosDisponibles)}

    REGLAS ESTRICTAS DE FLUJO PASO A PASO:
    1. INICIO OBLIGATORIO: Pide Nombre, Correo y WhatsApp. No avances hasta tener los 3.
    2. PREFERENCIAS: Pregunta cuántas puertas, asientos y transmisión busca.
    3. MOSTRAR CATÁLOGO: Cuando te dé sus preferencias, busca en el inventario los autos que coincidan. 
       ¡ATENCIÓN! Para mostrar los autos, DEBES llenar el arreglo "autos_recomendados" en tu respuesta JSON. NUNCA escribas la lista manualmente en el texto.
    4. COTIZACIÓN: Pide fechas, calcula el total, ofrece extras.
    5. CONFIRMACIÓN Y FOLIO: Genera un folio único (ej. RES-84K2P). Dile que su reserva está confirmada con ese folio y cambia "accion" a "guardar_reserva".
    6. CANCELAR: Pide el folio, confirma y cambia "accion" a "cancelar_reserva".

    FORMATO JSON OBLIGATORIO:
    {
        "respuesta_usuario": "Tu mensaje. NUNCA escribas la lista de autos aquí, usa el arreglo de abajo.",
        "accion": "hablar", 
        "autos_recomendados": [
            { "Vehiculo": "Nombre del auto", "Precio": "Precio", "Puertas": "4", "Asientos": "5", "Transmision": "Auto", "Imagen": "URL de la imagen" }
        ],
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
        historial.splice(1, historial.length - 8); 
    }

    try {
        const respuestaGroq = await groq.chat.completions.create({
            messages: historial,
            model: "llama-3.1-8b-instant",
            response_format: { type: "json_object" },
            temperature: 0.4 
        });

        let contenidoIA = respuestaGroq.choices[0].message.content;

        // Limpieza de JSON
        contenidoIA = contenidoIA.replace(/```json/g, '').replace(/```/g, '').trim();
        const inicioJSON = contenidoIA.indexOf('{');
        const finJSON = contenidoIA.lastIndexOf('}') + 1;
        
        if(inicioJSON === -1 || finJSON === 0) {
            throw new Error("No se pudo extraer JSON de la respuesta.");
        }

        const jsonLimpio = contenidoIA.substring(inicioJSON, finJSON);
        const iaJSON = JSON.parse(jsonLimpio);
        
        // ========================================================
        // 🛠️ PARCHES DE SEGURIDAD PARA CONSTRUIR TEXTO Y MENÚS
        // ========================================================

        // 1. Si la IA recomendó autos, NOSOTROS armamos el texto con la imagen para Telegram
        if (iaJSON.autos_recomendados && iaJSON.autos_recomendados.length > 0) {
            let textoAutos = "\n\n🚗 *Opciones recomendadas para ti:*\n";
            iaJSON.autos_recomendados.forEach(auto => {
                textoAutos += `\n🔹 *${auto.Vehiculo}* - $${auto.Precio}/día\nDetalles: ${auto.Puertas} ptas, ${auto.Asientos} asient, ${auto.Transmision}\n📸 Foto: ${auto.Imagen || "Sin imagen disponible"}\n`;
            });
            iaJSON.respuesta_usuario += textoAutos;
        }

        // 2. Mostrar Menú inicial si es un saludo
        const saludo = queryText.toLowerCase();
        if (saludo.includes('hola') || saludo.includes('menu') || saludo.includes('menú')) {
            if (!iaJSON.respuesta_usuario.includes('Rentar')) {
                iaJSON.respuesta_usuario += "\n\n¿En qué te puedo ayudar hoy?\n🚗 Rentar un auto\n❌ Cancelar reserva\n📋 Ver requisitos\n🎧 Soporte";
            }
        }

        // 3. Mostrar Menú al terminar una reserva o cancelación
        if (iaJSON.accion === "guardar_reserva" || iaJSON.accion === "cancelar_reserva") {
            iaJSON.respuesta_usuario += "\n\n¿Deseas iniciar un nuevo trámite?\n🚗 Rentar un auto\n❌ Cancelar reserva\n📋 Ver requisitos\n🎧 Soporte";
        }

        historial.push({ role: "assistant", content: JSON.stringify(iaJSON) });

        const nombreCliente = iaJSON.datos_cliente?.Nombre || "Cliente";
        const telefonoCliente = iaJSON.datos_cliente?.Telefono;
        const correoCliente = iaJSON.datos_cliente?.Correo;

        // EJECUTAR ACCIONES FINALES
        if (iaJSON.accion === "guardar_reserva") {
            console.log("⏳ Guardando reserva en SheetDB...");
            await guardarReserva({
                Nombre: nombreCliente,
                Telefono: telefonoCliente,
                Correo: correoCliente,
                ...iaJSON.datos_reserva,
                Estado: "Confirmado" 
            });

            if (telefonoCliente) {
                const msgWhatsapp = `🚗 *AutoRent* 🚗\n¡Hola ${nombreCliente}!\n\nTu reserva ha sido confirmada con éxito.\n*Modelo:* ${iaJSON.datos_reserva.Modelo}\n*Folio:* ${iaJSON.datos_reserva.Folio}\n*Fechas:* ${iaJSON.datos_reserva.Fecha_inicio} al ${iaJSON.datos_reserva.Fecha_fin}\n\n¡Gracias por elegirnos!`;
                await enviarWhatsAppUltramsg(telefonoCliente, msgWhatsapp);
            }

            if (correoCliente) {
                const asuntoCorreo = `Confirmación de Reserva AutoRent - Folio ${iaJSON.datos_reserva.Folio}`;
                const textoCorreo = `Hola ${nombreCliente},\n\nGracias por rentar con nosotros. Tu reserva del vehículo ${iaJSON.datos_reserva.Modelo} está confirmada.\n\nTus fechas son del ${iaJSON.datos_reserva.Fecha_inicio} al ${iaJSON.datos_reserva.Fecha_fin}.\nTu número de folio para cualquier aclaración es: ${iaJSON.datos_reserva.Folio}.\n\nSaludos,\nEl equipo de AutoRent`;
                await enviarCorreoConfirmacion(correoCliente, asuntoCorreo, textoCorreo);
            }

        } else if (iaJSON.accion === "cancelar_reserva") {
            console.log(`⏳ Cancelando reserva...`);
            const folioMayusculas = (iaJSON.datos_reserva.Folio || "").toUpperCase();
            await cancelarReserva(folioMayusculas);

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
