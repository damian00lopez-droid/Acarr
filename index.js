require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const Groq = require('groq-sdk');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;
const sheetdbUrl = process.env.SHEETDB_URL;

// ===============================
// 🔥 CONFIGURACIÓN MEJORADA
// ===============================
const CATALOGO_URL = process.env.CATALOGO_URL || "https://tu-catalogo-autos.com/buscar";
const MAX_HISTORIAL = 10; // Limitar historial para ahorrar tokens

// Sistema de caché para autos (evita consultas repetidas a SheetDB)
let cacheAutos = {
    data: [],
    lastUpdate: null,
    ttl: 5 * 60 * 1000 // 5 minutos
};

// ===============================
// 🔥 VALIDACIÓN Y LIMPIEZA DE API KEY
// ===============================
const RAW_KEY = process.env.GROQ_API_KEY || "";
const CLEAN_KEY = RAW_KEY.trim();

if (!CLEAN_KEY) {
    console.error("❌ ERROR: No se encontró GROQ_API_KEY en las variables de entorno.");
    process.exit(1); // Salir si no hay API key
} else {
    console.log(`🔑 Groq Key cargada correctamente. Longitud: ${CLEAN_KEY.length} caracteres.`);
}

const groq = new Groq({ apiKey: CLEAN_KEY });
const sesiones = new Map();

// ===============================
// 🔹 SISTEMA DE CACHÉ PARA AUTOS
// ===============================
async function obtenerAutos(forceRefresh = false) {
    try {
        // Usar caché si está vigente
        if (!forceRefresh && 
            cacheAutos.data.length > 0 && 
            cacheAutos.lastUpdate && 
            (Date.now() - cacheAutos.lastUpdate) < cacheAutos.ttl) {
            console.log("📦 Usando autos desde caché");
            return cacheAutos.data;
        }

        console.log("🔄 Consultando SheetDB para obtener autos...");
        const res = await fetch(sheetdbUrl);
        
        if (!res.ok) {
            throw new Error(`SheetDB respondió con status ${res.status}`);
        }
        
        const data = await res.json();
        const autosProcesados = data
            .filter(a => a.Disponibilidad === 'Disponible')
            .map(a => ({
                id: a.ID || `${a.Marca}-${a.Modelo}`.toLowerCase().replace(/\s+/g, '-'),
                marca: a.Marca,
                modelo: a.Modelo,
                vehiculo: `${a.Marca} ${a.Modelo}`,
                precio: parseFloat(a.Precio_Por_Dia) || 0,
                tipo: a.Tipo || "Sedan",
                transmision: a.Transmision || "Automática",
                año: a.Año || "2024",
                pasajeros: a.Pasajeros || "5",
                caracteristicas: a.Caracteristicas ? a.Caracteristicas.split(',') : []
            }));

        // Actualizar caché
        cacheAutos = {
            data: autosProcesados,
            lastUpdate: Date.now(),
            ttl: cacheAutos.ttl
        };

        console.log(`✅ ${autosProcesados.length} autos cargados en caché`);
        return autosProcesados;
        
    } catch (error) {
        console.error("❌ Error obteniendo autos:", error);
        // Si hay error pero tenemos caché antigua, la usamos
        if (cacheAutos.data.length > 0) {
            console.log("⚠️ Usando caché antigua debido al error");
            return cacheAutos.data;
        }
        return [];
    }
}

// ===============================
// 🔹 GENERADOR DE LINKS INTELIGENTES
// ===============================
function generarLinkCatalogo(preferencias = {}) {
    const params = new URLSearchParams();
    
    // Mapeo de preferencias a parámetros de URL
    if (preferencias.tipo) params.append('tipo', preferencias.tipo);
    if (preferencias.marca) params.append('marca', preferencias.marca);
    if (preferencias.transmision) params.append('transmision', preferencias.transmision);
    if (preferencias.precio_max) params.append('precio_max', preferencias.precio_max);
    if (preferencias.pasajeros) params.append('pasajeros', preferencias.pasajeros);
    
    // Añadir parámetro para tracking
    params.append('ref', 'chatbot');
    params.append('session', Date.now());
    
    const queryString = params.toString();
    return queryString ? `${CATALOGO_URL}?${queryString}` : CATALOGO_URL;
}

// ===============================
// 🔹 PROMPT DEL SISTEMA MEJORADO (CORREGIDO)
// ===============================
function generarPromptSistema(autos) {
    // Agrupar autos por categorías para el prompt
    const categorias = {};
    autos.forEach(auto => {
        if (!categorias[auto.tipo]) {
            categorias[auto.tipo] = [];
        }
        categorias[auto.tipo].push(auto);
    });

    // Crear resumen para el prompt (ahorramos tokens)
    const resumenAutos = Object.entries(categorias).map(([tipo, autosTipo]) => {
        const ejemplos = autosTipo.slice(0, 3).map(a => 
            `${a.marca} ${a.modelo} ($${a.precio}/día, ${a.transmision})`
        ).join(', ');
        return `- ${tipo}: ${autosTipo.length} disponibles. Ejemplos: ${ejemplos}${autosTipo.length > 3 ? ' y más...' : ''}`;
    }).join('\n');

    return `Eres AutoRent Assistant, un asistente especializado en renta de autos. Tu objetivo es ayudar al cliente a encontrar el vehículo perfecto de manera eficiente y amigable.

🚗 **CATÁLOGO ACTUAL (${autos.length} vehículos disponibles):**
${resumenAutos}

📋 **PROTOCOLO DE ATENCIÓN:**
1. **Saludo inicial**: Preséntate brevemente y pregunta qué tipo de vehículo busca el cliente.
2. **Descubrimiento de necesidades**: Haz preguntas sobre:
   - Tipo de uso (ciudad, viaje largo, familiar, lujo)
   - Número de pasajeros
   - Preferencia de transmisión (automática/manual)
   - Presupuesto aproximado por día
3. **Recomendación personalizada**: Basada en las respuestas, recomienda 2-3 opciones específicas.
4. **Enlace al catálogo**: NUNCA envíes imágenes. En su lugar, genera un link personalizado usando esta estructura:
   ${CATALOGO_URL}?tipo=TIPO&marca=MARCA&transmision=TIPO&precio_max=CANTIDAD
   
   Ejemplo de respuesta: "¡Excelente elección! Puedes ver todos nuestros vehículos del tipo que buscas aquí: [ENLACE]. Cuando hayas elegido, regresa y dime cuál te gustó para continuar con la reserva."

5. **Proceso de reserva**: Una vez que el cliente elija un vehículo específico:
   - Solicita: Nombre completo, Teléfono (10 dígitos), Correo electrónico
   - Solicita: Fechas de renta (inicio y fin)
   - Confirma los detalles antes de finalizar

⚠️ **REGLAS IMPORTANTES:**
- NO envíes imágenes ni archivos adjuntos
- SIEMPRE proporciona el enlace al catálogo cuando el cliente pida ver opciones
- El enlace DEBE incluir los filtros según las preferencias expresadas
- Mantén un tono profesional pero amigable
- Si el cliente pide algo fuera del alcance, indícalo amablemente

📊 **FORMATO DE RESPUESTA JSON:**
{
  "respuesta_usuario": "Texto completo para el cliente (incluye el enlace si aplica)",
  "accion": "hablar | recomendar | solicitar_datos | confirmar_reserva | guardar_reserva | cancelar",
  "preferencias_detectadas": {
    "tipo": "string o null",
    "marca": "string o null", 
    "transmision": "string o null",
    "precio_max": "número o null",
    "pasajeros": "número o null"
  },
  "vehiculo_seleccionado": "string o null",
  "datos_cliente": {
    "nombre": "",
    "telefono": "",
    "correo": ""
  },
  "datos_reserva": {
    "vehiculo": "",
    "fecha_inicio": "",
    "fecha_fin": "",
    "dias": 0,
    "precio_total": 0
  }
}`;
}

// ===============================
// 🔹 WHATSAPP (ULTRAMSG) - MEJORADO
// ===============================
async function enviarWhatsAppUltramsg(numero, mensaje) {
    const instanceId = process.env.ULTRAMSG_INSTANCE_ID;
    const token = process.env.ULTRAMSG_TOKEN;

    if (!instanceId || !token) {
        console.warn("⚠️ ULTRAMSG no configurado");
        return false;
    }

    try {
        const numeroLimpio = numero.replace(/\D/g, '');
        
        // Limitar longitud del mensaje para WhatsApp
        const mensajeLimitado = mensaje.length > 1000 ? 
            mensaje.substring(0, 997) + '...' : mensaje;
        
        const url = `https://api.ultramsg.com/${instanceId}/messages/chat`;
        const params = new URLSearchParams();
        params.append("token", token);
        params.append("to", numeroLimpio);
        params.append("body", mensajeLimitado);
        params.append("priority", "10"); // Prioridad normal

        const response = await fetch(url, { 
            method: 'POST', 
            body: params,
            timeout: 5000 // 5 segundos timeout
        });
        
        if (response.ok) {
            console.log(`✅ WhatsApp enviado a ${numeroLimpio}`);
            return true;
        } else {
            console.error(`❌ Error WhatsApp: ${response.status}`);
            return false;
        }
    } catch (error) {
        console.error("❌ Error enviando WhatsApp:", error.message);
        return false;
    }
}

// ===============================
// 🔹 CORREO (NODEMAILER) - MEJORADO
// ===============================
async function enviarCorreoConfirmacion(correoDestino, datosReserva, datosCliente) {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
        console.warn("⚠️ SMTP no configurado");
        return false;
    }

    try {
        const asunto = `✅ Confirmación de Reserva - ${datosReserva.vehiculo}`;
        
        const texto = `
¡Hola ${datosCliente.nombre}!

Tu reserva ha sido confirmada exitosamente:

🚗 Vehículo: ${datosReserva.vehiculo}
📅 Fecha inicio: ${datosReserva.fecha_inicio}
📅 Fecha fin: ${datosReserva.fecha_fin}
⏱️ Total días: ${datosReserva.dias}
💰 Precio total: $${datosReserva.precio_total} MXN

📍 Recoge tu vehículo en nuestra sucursal presentando tu identificación oficial.

Si necesitas modificar tu reserva, contáctanos al menos 24 horas antes.

¡Gracias por elegir AutoRent!

---
Este es un correo automático, por favor no responder.
        `.trim();

        let transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST || "smtp.gmail.com",
            port: parseInt(process.env.SMTP_PORT) || 587,
            secure: false,
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            },
            tls: {
                rejectUnauthorized: false
            }
        });

        await transporter.sendMail({
            from: `"AutoRent" <${process.env.SMTP_USER}>`,
            to: correoDestino,
            subject: asunto,
            text: texto,
            html: texto.replace(/\n/g, '<br>') // Versión HTML simple
        });
        
        console.log(`📧 Correo enviado a ${correoDestino}`);
        return true;
    } catch (error) {
        console.error("❌ Error enviando correo:", error.message);
        return false;
    }
}

// ===============================
// 🔹 BASE DE DATOS (SHEETDB) - MEJORADO
// ===============================
async function guardarReserva(datosCliente, datosReserva) {
    try {
        const registro = {
            Fecha_Reserva: new Date().toISOString().split('T')[0],
            Hora_Reserva: new Date().toTimeString().split(' ')[0],
            Nombre_Cliente: datosCliente.nombre,
            Telefono_Cliente: datosCliente.telefono,
            Correo_Cliente: datosCliente.correo,
            Vehiculo: datosReserva.vehiculo,
            Fecha_Inicio: datosReserva.fecha_inicio,
            Fecha_Fin: datosReserva.fecha_fin,
            Dias_Total: datosReserva.dias,
            Precio_Total: datosReserva.precio_total,
            Estado: 'Confirmada',
            Origen: 'Chatbot',
            Folio: `AR-${Date.now().toString(36).toUpperCase()}`
        };

        const response = await fetch(`${sheetdbUrl}?sheet=Reservas`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({ data: [registro] })
        });

        if (!response.ok) {
            throw new Error(`SheetDB error: ${response.status}`);
        }

        console.log(`✅ Reserva guardada - Folio: ${registro.Folio}`);
        return registro.Folio;
    } catch (error) {
        console.error("❌ Error guardando reserva:", error.message);
        return null;
    }
}

// ===============================
// 🔹 VALIDADORES
// ===============================
function validarTelefono(telefono) {
    const limpio = telefono.replace(/\D/g, '');
    return limpio.length >= 10 && limpio.length <= 15;
}

function validarCorreo(correo) {
    const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return regex.test(correo);
}

function validarFechas(fechaInicio, fechaFin) {
    try {
        const inicio = new Date(fechaInicio);
        const fin = new Date(fechaFin);
        const hoy = new Date();
        hoy.setHours(0, 0, 0, 0);
        
        return inicio >= hoy && fin > inicio;
    } catch {
        return false;
    }
}

// ===============================
// 🔹 GESTIÓN DE SESIONES MEJORADA
// ===============================
function gestionarSesion(sessionId, promptSistema) {
    if (!sesiones.has(sessionId)) {
        sesiones.set(sessionId, []);
    }
    
    let historial = sesiones.get(sessionId);
    
    // Actualizar o agregar mensaje del sistema
    if (historial.length === 0 || historial[0].role !== "system") {
        historial.unshift({ role: "system", content: promptSistema });
    } else {
        historial[0].content = promptSistema;
    }
    
    // Limitar historial para no exceder tokens
    if (historial.length > MAX_HISTORIAL) {
        // Mantener el mensaje del sistema y los últimos mensajes
        const mensajeSistema = historial[0];
        historial = [mensajeSistema, ...historial.slice(-MAX_HISTORIAL + 1)];
        sesiones.set(sessionId, historial);
    }
    
    return historial;
}

// ===============================
// 🚀 WEBHOOK PRINCIPAL - MEJORADO
// ===============================
app.post('/webhook', async (req, res) => {
    console.log("📨 Webhook recibido:", new Date().toISOString());
    
    try {
        const queryText = req.body.queryResult?.queryText || "";
        const sessionId = req.body.session || req.body.sessionId || "default";
        
        // Obtener autos (con caché)
        const autos = await obtenerAutos();
        
        if (autos.length === 0) {
            return res.json({
                fulfillmentText: "Lo siento, en este momento no puedo acceder al catálogo de vehículos. Por favor, intenta más tarde o contáctanos por teléfono."
            });
        }

        // Generar prompt actualizado
        const promptSistema = generarPromptSistema(autos);
        
        // Gestionar historial
        const historial = gestionarSesion(sessionId, promptSistema);
        historial.push({ role: "user", content: queryText });

        // Llamar a Groq
        const completion = await groq.chat.completions.create({
            messages: historial,
            model: "llama-3.1-8b-instant",
            response_format: { type: "json_object" },
            temperature: 0.3,
            max_tokens: 500
        });

        let respuestaIA;
        try {
            const content = completion.choices[0].message.content.trim();
            respuestaIA = JSON.parse(content);
        } catch (parseError) {
            console.error("❌ Error parseando JSON de Groq:", parseError);
            respuestaIA = {
                respuesta_usuario: "Entendido. ¿Podrías darme más detalles sobre qué tipo de vehículo buscas?",
                accion: "hablar",
                preferencias_detectadas: {}
            };
        }

        // Procesar acciones
        let respuestaFinal = respuestaIA.respuesta_usuario;
        
        // Si es recomendación, generar link personalizado
        if (respuestaIA.accion === "recomendar" && respuestaIA.preferencias_detectadas) {
            const linkCatalogo = generarLinkCatalogo(respuestaIA.preferencias_detectadas);
            respuestaFinal = respuestaFinal.replace('[ENLACE]', linkCatalogo);
            
            // Asegurar que el link esté presente
            if (!respuestaFinal.includes(CATALOGO_URL)) {
                respuestaFinal += `\n\n🔗 Puedes ver el catálogo filtrado aquí: ${linkCatalogo}`;
            }
        }
        
        // Procesar reserva
        if (respuestaIA.accion === "guardar_reserva") {
            const { datos_cliente, datos_reserva } = respuestaIA;
            
            // Validaciones
            if (!validarTelefono(datos_cliente.telefono)) {
                respuestaFinal = "El número de teléfono no parece válido. Por favor, proporciónalo nuevamente (10 dígitos).";
            } else if (!validarCorreo(datos_cliente.correo)) {
                respuestaFinal = "El correo electrónico no parece válido. Por favor, verifícalo.";
            } else if (!validarFechas(datos_reserva.fecha_inicio, datos_reserva.fecha_fin)) {
                respuestaFinal = "Las fechas no son válidas. La fecha de inicio debe ser hoy o posterior, y la fecha de fin debe ser posterior al inicio.";
            } else {
                // Guardar reserva
                const folio = await guardarReserva(datos_cliente, datos_reserva);
                
                if (folio) {
                    // Notificaciones
                    const mensajeWpp = `✅ ¡Reserva confirmada ${datos_cliente.nombre}!\n🚗 ${datos_reserva.vehiculo}\n📅 ${datos_reserva.fecha_inicio} al ${datos_reserva.fecha_fin}\n💰 Total: $${datos_reserva.precio_total}\n📋 Folio: ${folio}`;
                    
                    await enviarWhatsAppUltramsg(datos_cliente.telefono, mensajeWpp);
                    await enviarCorreoConfirmacion(datos_cliente.correo, datos_reserva, datos_cliente);
                    
                    respuestaFinal = `✅ ¡Reserva confirmada!\n\n${mensajeWpp}\n\nTe hemos enviado los detalles por WhatsApp y correo electrónico. ¡Gracias por elegir AutoRent!`;
                } else {
                    respuestaFinal = "Hubo un problema al guardar tu reserva. Por favor, intenta nuevamente en unos minutos.";
                }
            }
        }

        // Guardar respuesta en historial
        historial.push({ 
            role: "assistant", 
            content: JSON.stringify(respuestaIA) 
        });

        // Responder a Dialogflow
        res.json({
            fulfillmentMessages: [
                {
                    text: {
                        text: [respuestaFinal]
                    }
                }
            ]
        });

        console.log(`✅ Respuesta enviada - Sesión: ${sessionId}`);

    } catch (error) {
        console.error("❌ ERROR CRÍTICO EN WEBHOOK:", error);
        res.json({
            fulfillmentText: "Lo siento, hubo un error inesperado. Por favor, intenta de nuevo en unos momentos."
        });
    }
});

// ===============================
// 🔹 ENDPOINT DE SALUD
// ===============================
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        sesionesActivas: sesiones.size,
        autosEnCache: cacheAutos.data.length
    });
});

// ===============================
// 🚀 INICIAR SERVIDOR
// ===============================
app.listen(port, () => {
    console.log(`
╔════════════════════════════════════════╗
║     🚗 AutoRent Chatbot API v2.0      ║
╠════════════════════════════════════════╣
║  Puerto: ${port}                         ║
║  Entorno: ${process.env.NODE_ENV || 'development'}                ║
║  Catálogo: ${CATALOGO_URL}
╠════════════════════════════════════════╣
║  Endpoints:                            ║
║  - POST /webhook    (Dialogflow)       ║
║  - GET  /health     (Monitor)          ║
╚════════════════════════════════════════╝
    `);
});

// Manejo de errores no capturados
process.on('uncaughtException', (error) => {
    console.error('❌ Error no capturado:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('❌ Promesa rechazada no manejada:', error);
});
