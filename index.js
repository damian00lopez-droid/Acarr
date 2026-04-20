require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const Groq = require('groq-sdk');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());
app.use(express.static('public')); // Servir archivos estáticos (catalogo.html)

const port = process.env.PORT || 3000;
const sheetdbUrl = process.env.SHEETDB_URL;

// ===============================
// 🔥 CONFIGURACIÓN
// ===============================
const CATALOGO_URL = process.env.CATALOGO_URL || "https://tu-app.onrender.com/catalogo.html";
const MAX_HISTORIAL = 10;

// Cache de autos
let cacheAutos = {
    data: [],
    lastUpdate: null,
    ttl: 5 * 60 * 1000
};

// ===============================
// 🔥 VALIDACIÓN API KEY GROQ
// ===============================
const RAW_KEY = process.env.GROQ_API_KEY || "";
const CLEAN_KEY = RAW_KEY.trim();

if (!CLEAN_KEY) {
    console.error("❌ ERROR: No se encontró GROQ_API_KEY");
    process.exit(1);
} else {
    console.log(`🔑 Groq Key cargada. Longitud: ${CLEAN_KEY.length}`);
}

const groq = new Groq({ apiKey: CLEAN_KEY });
const sesiones = new Map();

// ===============================
// 🔹 SISTEMA DE CACHÉ PARA AUTOS
// ===============================
async function obtenerAutos(forceRefresh = false) {
    try {
        if (!forceRefresh &&
            cacheAutos.data.length > 0 &&
            cacheAutos.lastUpdate &&
            (Date.now() - cacheAutos.lastUpdate) < cacheAutos.ttl) {
            console.log("📦 Usando autos desde caché");
            return cacheAutos.data;
        }

        console.log("🔄 Consultando SheetDB...");
        const res = await fetch(sheetdbUrl);
        if (!res.ok) throw new Error(`SheetDB status ${res.status}`);
        
        const data = await res.json();
        const autosProcesados = data
            .filter(a => a.Disponibilidad === 'Disponible')
            .map(a => ({
                id: a.ID_Auto || `${a.Marca}-${a.Modelo}`.toLowerCase().replace(/\s+/g, '-'),
                marca: a.Marca,
                modelo: a.Modelo,
                vehiculo: `${a.Marca} ${a.Modelo}`,
                precio: parseFloat(a.Precio_Por_Dia) || 0,
                tipo: a.Categoria || "Sedan",
                transmision: a.Transmision || "Automática",
                puertas: a.Puertas || "4",
                pasajeros: a.Asientos || "5",
                imagen: a.Imagen || "",
                año: a.Año || "2024"
            }));

        cacheAutos = {
            data: autosProcesados,
            lastUpdate: Date.now(),
            ttl: cacheAutos.ttl
        };

        console.log(`✅ ${autosProcesados.length} autos en caché`);
        return autosProcesados;
    } catch (error) {
        console.error("❌ Error obteniendo autos:", error);
        return cacheAutos.data.length ? cacheAutos.data : [];
    }
}

// ===============================
// 🔹 NUEVO ENDPOINT: API AUTOS (PARA CATÁLOGO)
// ===============================
app.get('/api/autos', async (req, res) => {
    try {
        const autos = await obtenerAutos();
        let resultados = [...autos];
        
        // Aplicar filtros recibidos por query string
        const { tipo, marca, transmision, precio_max, pasajeros } = req.query;
        
        if (tipo) resultados = resultados.filter(a => a.tipo.toLowerCase() === tipo.toLowerCase());
        if (marca) resultados = resultados.filter(a => a.marca.toLowerCase() === marca.toLowerCase());
        if (transmision) resultados = resultados.filter(a => a.transmision.toLowerCase() === transmision.toLowerCase());
        if (precio_max) resultados = resultados.filter(a => a.precio <= parseFloat(precio_max));
        if (pasajeros) resultados = resultados.filter(a => parseInt(a.pasajeros) >= parseInt(pasajeros));
        
        res.json(resultados);
    } catch (error) {
        console.error("Error en /api/autos:", error);
        res.status(500).json({ error: "Error interno del servidor" });
    }
});

// ===============================
// 🔹 GENERADOR DE LINKS INTELIGENTES
// ===============================
function generarLinkCatalogo(preferencias = {}) {
    const params = new URLSearchParams();
    if (preferencias.tipo) params.append('tipo', preferencias.tipo);
    if (preferencias.marca) params.append('marca', preferencias.marca);
    if (preferencias.transmision) params.append('transmision', preferencias.transmision);
    if (preferencias.precio_max) params.append('precio_max', preferencias.precio_max);
    if (preferencias.pasajeros) params.append('pasajeros', preferencias.pasajeros);
    params.append('ref', 'chatbot');
    
    const queryString = params.toString();
    return queryString ? `${CATALOGO_URL}?${queryString}` : CATALOGO_URL;
}

// ===============================
// 🔹 PROMPT DEL SISTEMA (ESPAÑOL + MENÚ INICIAL)
// ===============================
function generarPromptSistema(autos) {
    const categorias = {};
    autos.forEach(auto => {
        if (!categorias[auto.tipo]) categorias[auto.tipo] = [];
        categorias[auto.tipo].push(auto);
    });

    const resumenAutos = Object.entries(categorias).map(([tipo, autosTipo]) => {
        const ejemplos = autosTipo.slice(0, 3).map(a => 
            `${a.marca} ${a.modelo} ($${a.precio}/día, ${a.transmision})`
        ).join(', ');
        return `- ${tipo}: ${autosTipo.length} disponibles. Ejemplos: ${ejemplos}${autosTipo.length > 3 ? ' y más...' : ''}`;
    }).join('\n');

    return `Eres AutoRent Assistant, asistente de renta de autos. Tu objetivo es guiar al cliente de manera cálida y eficiente.

🚗 **CATÁLOGO ACTUAL (${autos.length} vehículos):**
${resumenAutos}

📌 **SALUDO INICIAL OBLIGATORIO** (cuando el usuario escribe por primera vez o después de finalizar una operación):
Debes responder exactamente:
"¡Bienvenido a AutoRent! 😊 Para continuar, necesito saber un poco más sobre ti. Por favor, proporciona tu **nombre completo**, **correo electrónico** y **número de WhatsApp** (10 dígitos).

¿En qué te puedo ayudar hoy?
1️⃣ Rentar un auto
2️⃣ Cancelar reserva
3️⃣ Ver requisitos
4️⃣ Soporte"

Si el usuario responde con "1" o "Rentar un auto", procede a preguntar qué tipo de vehículo necesita.
Si responde "2" o "Cancelar reserva", solicita el folio o datos de la reserva para cancelar.
Si responde "3" o "Ver requisitos", muestra los requisitos: identificación oficial vigente, licencia de conducir, tarjeta de crédito y ser mayor de 21 años.
Si responde "4" o "Soporte", informa que un agente humano se comunicará en breve y pide confirmación del número de WhatsApp.

📋 **PROTOCOLO DE ATENCIÓN:**
1. **Recolección de datos personales**: Antes de iniciar cualquier trámite, asegúrate de tener nombre, correo y teléfono.
2. **Recomendación**: Basada en preferencias, recomienda 2-3 opciones y proporciona el enlace al catálogo filtrado.
3. **Enlace al catálogo**: Siempre usa la función generarLinkCatalogo(preferencias). El enlace debe llevar a ${CATALOGO_URL} con los filtros adecuados.
4. **Reserva**: Una vez elegido el vehículo, solicita fechas de inicio y fin, calcula días y precio total, y confirma.
5. **Cancelación**: Pide folio y simula la cancelación indicando que se ha procesado.

⚠️ **REGLAS:**
- NO envíes imágenes.
- El enlace al catálogo debe aparecer cuando el cliente pida ver opciones.
- Al finalizar cualquier operación (renta, cancelación, requisitos, soporte), pregunta: "¿Hay algo más en lo que pueda ayudarte?" y vuelve a mostrar el menú si el usuario desea continuar.

📊 **FORMATO DE RESPUESTA JSON:**
{
  "respuesta_usuario": "Texto para el cliente",
  "accion": "hablar | recomendar | solicitar_datos | confirmar_reserva | guardar_reserva | cancelar | ver_requisitos | soporte",
  "preferencias_detectadas": {
    "tipo": null,
    "marca": null,
    "transmision": null,
    "precio_max": null,
    "pasajeros": null
  },
  "vehiculo_seleccionado": null,
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
// 🔹 FUNCIONES DE ENVÍO (WhatsApp, Correo, SheetDB)
// ===============================
async function enviarWhatsAppUltramsg(numero, mensaje) {
    const instanceId = process.env.ULTRAMSG_INSTANCE_ID;
    const token = process.env.ULTRAMSG_TOKEN;
    if (!instanceId || !token) return false;

    try {
        const numeroLimpio = numero.replace(/\D/g, '');
        const url = `https://api.ultramsg.com/${instanceId}/messages/chat`;
        const params = new URLSearchParams({
            token, to: numeroLimpio, body: mensaje, priority: "10"
        });
        const response = await fetch(url, { method: 'POST', body: params });
        return response.ok;
    } catch (error) {
        console.error("Error WhatsApp:", error);
        return false;
    }
}

async function enviarCorreoConfirmacion(correoDestino, datosReserva, datosCliente) {
    if (!process.env.SMTP_USER) return false;
    try {
        let transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST || "smtp.gmail.com",
            port: parseInt(process.env.SMTP_PORT) || 587,
            secure: false,
            auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        });
        await transporter.sendMail({
            from: `"AutoRent" <${process.env.SMTP_USER}>`,
            to: correoDestino,
            subject: `✅ Confirmación de Reserva - ${datosReserva.vehiculo}`,
            text: `Hola ${datosCliente.nombre},\n\nTu reserva ha sido confirmada:\nVehículo: ${datosReserva.vehiculo}\nFechas: ${datosReserva.fecha_inicio} al ${datosReserva.fecha_fin}\nTotal: $${datosReserva.precio_total}\n\nGracias por elegir AutoRent.`
        });
        return true;
    } catch (error) {
        console.error("Error correo:", error);
        return false;
    }
}

async function guardarReserva(datosCliente, datosReserva) {
    try {
        const registro = {
            Folio: `AR-${Date.now().toString(36).toUpperCase()}`,
            Nombre: datosCliente.nombre,
            Telefono: datosCliente.telefono,
            Email: datosCliente.correo,
            Modelo: datosReserva.vehiculo,
            Fecha_inicio: datosReserva.fecha_inicio,
            Fecha_fin: datosReserva.fecha_fin,
            Estado: 'Confirmada'
        };
        const response = await fetch(`${sheetdbUrl}?sheet=Reservas`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: [registro] })
        });
        if (!response.ok) throw new Error("Error SheetDB");
        return registro.Folio;
    } catch (error) {
        console.error("Error guardar reserva:", error);
        return null;
    }
}

// ===============================
// 🔹 GESTIÓN DE SESIONES
// ===============================
function gestionarSesion(sessionId, promptSistema) {
    if (!sesiones.has(sessionId)) {
        sesiones.set(sessionId, []);
    }
    let historial = sesiones.get(sessionId);
    if (historial.length === 0 || historial[0].role !== "system") {
        historial.unshift({ role: "system", content: promptSistema });
    } else {
        historial[0].content = promptSistema;
    }
    if (historial.length > MAX_HISTORIAL) {
        const sysMsg = historial[0];
        historial = [sysMsg, ...historial.slice(-MAX_HISTORIAL + 1)];
        sesiones.set(sessionId, historial);
    }
    return historial;
}

// ===============================
// 🚀 WEBHOOK PRINCIPAL (Dialogflow)
// ===============================
app.post('/webhook', async (req, res) => {
    console.log("📨 Webhook recibido");
    try {
        const queryText = req.body.queryResult?.queryText || "";
        const sessionId = req.body.session || "default";
        
        const autos = await obtenerAutos();
        if (autos.length === 0) {
            return res.json({ fulfillmentText: "Catálogo no disponible. Intenta más tarde." });
        }

        const promptSistema = generarPromptSistema(autos);
        const historial = gestionarSesion(sessionId, promptSistema);
        
        // Detectar si es primera interacción (historial solo tiene system)
        if (historial.length === 1) {
            const bienvenida = `¡Bienvenido a AutoRent! 😊 Para continuar, necesito saber un poco más sobre ti. Por favor, proporciona tu **nombre completo**, **correo electrónico** y **número de WhatsApp** (10 dígitos).

¿En qué te puedo ayudar hoy?
1️⃣ Rentar un auto
2️⃣ Cancelar reserva
3️⃣ Ver requisitos
4️⃣ Soporte`;
            historial.push({ role: "assistant", content: JSON.stringify({ respuesta_usuario: bienvenida, accion: "hablar" }) });
            return res.json({ fulfillmentText: bienvenida });
        }
        
        historial.push({ role: "user", content: queryText });

        const completion = await groq.chat.completions.create({
            messages: historial,
            model: "llama-3.1-8b-instant",
            response_format: { type: "json_object" },
            temperature: 0.3,
            max_tokens: 500
        });

        let respuestaIA;
        try {
            respuestaIA = JSON.parse(completion.choices[0].message.content);
        } catch {
            respuestaIA = { respuesta_usuario: "No entendí bien. ¿Podrías repetir?", accion: "hablar" };
        }

        let respuestaFinal = respuestaIA.respuesta_usuario;

        // Manejar acciones específicas del menú
        if (respuestaIA.accion === "recomendar") {
            const link = generarLinkCatalogo(respuestaIA.preferencias_detectadas || {});
            respuestaFinal = respuestaFinal.replace('[ENLACE]', link);
        }
        
        if (respuestaIA.accion === "guardar_reserva") {
            const { datos_cliente, datos_reserva } = respuestaIA;
            const folio = await guardarReserva(datos_cliente, datos_reserva);
            if (folio) {
                const mensajeWpp = `✅ Reserva confirmada ${datos_cliente.nombre}\n🚗 ${datos_reserva.vehiculo}\n📅 ${datos_reserva.fecha_inicio} - ${datos_reserva.fecha_fin}\n💰 Total: $${datos_reserva.precio_total}\n📋 Folio: ${folio}`;
                await enviarWhatsAppUltramsg(datos_cliente.telefono, mensajeWpp);
                await enviarCorreoConfirmacion(datos_cliente.correo, datos_reserva, datos_cliente);
                respuestaFinal = `✅ ¡Reserva confirmada!\n${mensajeWpp}\n\nTe hemos enviado los detalles por WhatsApp y correo. ¿Hay algo más en lo que pueda ayudarte?`;
            } else {
                respuestaFinal = "Hubo un problema al guardar la reserva. Intenta de nuevo.";
            }
        }

        if (respuestaIA.accion === "cancelar") {
            respuestaFinal = "🔁 He procesado tu solicitud de cancelación. Si tenías una reserva activa, ha sido cancelada. ¿Necesitas algo más?";
        }

        if (respuestaIA.accion === "ver_requisitos") {
            respuestaFinal = "📋 **Requisitos para rentar:**\n- Identificación oficial vigente\n- Licencia de conducir vigente\n- Tarjeta de crédito para garantía\n- Ser mayor de 21 años\n\n¿Te gustaría continuar con una renta?";
        }

        if (respuestaIA.accion === "soporte") {
            respuestaFinal = "🎧 Un agente de soporte se comunicará contigo a la brevedad al número de WhatsApp que proporcionaste. Gracias por tu paciencia. ¿Puedo ayudarte en algo más mientras tanto?";
        }

        historial.push({ role: "assistant", content: JSON.stringify(respuestaIA) });
        res.json({ fulfillmentText: respuestaFinal });

    } catch (error) {
        console.error("❌ Error en webhook:", error);
        res.json({ fulfillmentText: "Error interno. Por favor intenta más tarde." });
    }
});

// ===============================
// 🔹 HEALTH CHECK
// ===============================
app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString(), sesiones: sesiones.size, cache: cacheAutos.data.length });
});

// ===============================
// 🚀 INICIAR SERVIDOR
// ===============================
app.listen(port, () => {
    console.log(`\n🚗 AutoRent AI v3.0 corriendo en puerto ${port}`);
    console.log(`   Catálogo: ${CATALOGO_URL}`);
    console.log(`   API Autos: /api/autos\n`);
});
