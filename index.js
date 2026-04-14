require('dotenv').config();
const express = require('express');
const { Resend } = require('resend');

const port = process.env.PORT || 3000;
const sheetdbUrl = process.env.SHEETDB_URL;

const app = express();
app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);

const agencias = [
    { nombre: "Agencia CU (UNAM)", direccion: "Av. Insurgentes Sur 3000, Coyoacán" },
    { nombre: "Agencia Centro (CDMX)", direccion: "Av. Juárez 20, Centro Histórico" },
    { nombre: "Agencia Norte (Satélite)", direccion: "Cto. Centro Comercial 15, Naucalpan" }
];

// --- FUNCIONES DE APOYO ---
function generarLinkMaps(query) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

async function obtenerCatalogoSheetDB() {
    try {
        const response = await fetch(sheetdbUrl);
        const autos = await response.json();
        return autos.filter(auto => auto.Disponibilidad === 'Disponible').slice(0, 3);
    } catch (error) {
        console.error("Error consultando SheetDB:", error);
        return [];
    }
}

async function guardarReservaSheetDB(datos) {
    try {
        await fetch(sheetdbUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: [datos] })
        });
    } catch (error) {
        console.error("Error guardando en SheetDB:", error);
    }
}

// --- RUTA EXCLUSIVA PARA DIALOGFLOW ---
app.post('/webhook', async (req, res) => {
    // Extraemos el nombre de la intención detectada por Dialogflow
    const intentName = req.body.queryResult.intent.displayName;
    const parameters = req.body.queryResult.parameters;

    console.log(`Intent recibido: ${intentName}`);

    if (intentName === 'Ver Catalogo') {
        const autos = await obtenerCatalogoSheetDB();
        
        if (autos.length === 0) {
            return res.json({ fulfillmentText: "En este momento no hay vehículos disponibles." });
        }
        
        let respuesta = "🚘 Nuestro Catálogo Destacado:\n\n";
        autos.forEach(a => respuesta += `• ${a.Marca} ${a.Modelo} - $${a.Precio_Por_Dia}/día\n`);
        
        return res.json({ fulfillmentText: respuesta });
    }

    if (intentName === 'Ver Agencias') {
        let msgAgencias = "📍 Nuestras Sucursales:\n\n";
        agencias.forEach(a => {
            msgAgencias += `• ${a.nombre}\n  Link de mapa: ${generarLinkMaps(a.direccion)}\n\n`;
        });
        
        return res.json({ fulfillmentText: msgAgencias });
    }

    if (intentName === 'Finalizar Reserva') {
        // En este Intent, Dialogflow ya debió preguntar y guardar estos parámetros:
        const autoElegido = parameters.auto || 'Auto no especificado';
        const direccionEntrega = parameters.direccion || 'Sucursal principal';
        const mapLink = generarLinkMaps(direccionEntrega);

        // Guardamos en SheetDB
        await guardarReservaSheetDB({
            Fecha: new Date().toLocaleString(),
            Auto: autoElegido,
            Ubicacion: direccionEntrega
        });

        // Enviamos el correo con Resend
        try {
            if (process.env.RESEND_API_KEY) {
                await resend.emails.send({
                    from: 'AutoRent System <onboarding@resend.dev>',
                    to: 'TU_CORREO_AQUI@gmail.com', // <--- CAMBIA ESTO
                    subject: `Nueva Reserva: ${autoElegido}`,
                    html: `<h2>Reserva Generada</h2><p><b>Auto:</b> ${autoElegido}</p><p><b>Dirección:</b> ${direccionEntrega}</p>`
                });
            }
        } catch (e) { console.error("Error en correo", e); }

        const waText = encodeURIComponent(`Hola, acabo de realizar una reserva del auto: ${autoElegido}`);
        const waLink = `https://wa.me/525512345678?text=${waText}`;

        const respuestaFinal = `✅ ¡Reserva Confirmada!\n\n🚗 Vehículo: ${autoElegido}\n📍 Ubicación: ${direccionEntrega}\n🗺️ Mapa: ${mapLink}\n\n💬 Si necesitas ayuda extra, envíanos un WhatsApp aquí: ${waLink}`;
        
        return res.json({ fulfillmentText: respuestaFinal });
    }

    // Respuesta por defecto si el backend no reconoce el Intent
    return res.json({ fulfillmentText: "Recibí la solicitud en el servidor, pero no estoy configurado para este Intent." });
});

app.listen(port, () => console.log(`🚀 Webhook de Dialogflow corriendo en el puerto ${port}`));
