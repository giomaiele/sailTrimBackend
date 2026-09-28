const express = require("express");
const colors = require("colors");
// const dotenv = require("dotenv").config({ path: "./backend/.env" });
require("dotenv").config();
const port = process.env.PORT || 5000;
const { errorHandler } = require("./middleware/errorMiddleware");
const connectDB = require("./config/db");

// const sessionDeleteCronJob = require("./jobs/deleteSession.js");
const cors = require("cors");
const helmet = require("helmet");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
// const Mailjet = require("node-mailjet"); // Para enviar correos
const User = require("./model/userModel.js");
const bodyParser = require("body-parser");

// const mailjet = Mailjet.apiConnect(
//   process.env.MJ_APIKEY_PUBLIC,
//   process.env.MJ_APIKEY_PRIVATE
// );

connectDB();

const app = express();
app.get("/", (req, res) => {
  res.status(200).send("ok");
});

// app.post(
//   "/webhookFailPayments",
//   express.raw({ type: "application/json" }),
//   async (req, res) => {
//     const sig = req.headers["stripe-signature"];
//     let event;
//     console.log("event", event);

//     try {
//       // Verificar que el evento venga de Stripe usando la clave del webhook (Webhook Signing Secret)
//       event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
//     } catch (err) {
//       console.error("⚠️ Webhook signature verification failed:", err.message);
//       return res.status(400).send(`Webhook Error: ${err.message}`);
//     }

//     if (event.type === "payment_intent.requires_action") {
//       const paymentIntent = event.data.object;
//       const customerId = paymentIntent.customer;

//       // Buscar al usuario en la base de datos
//       const user = await User.findOne({ customerIdStripe: customerId });

//       if (user) {
//         // Guardar el `client_secret` en el campo `secretKeyStripe` del usuario
//         user.secretKeyStripe = paymentIntent.client_secret;
//         await user.save();

//         const request = mailjet.post("send", { version: "v3.1" }).request({
//           Messages: [
//             {
//               From: {
//                 Email: "novaappai@gmail.com", // Cambia a tu correo
//                 Name: "NOVA AI", // Nombre que aparecerá como remitente
//               },
//               To: [
//                 {
//                   Email: user.email, // Email del usuario (se obtiene desde la base de datos)
//                   Name: `${user.firstName} ${user.lastName}`, // Nombre completo del usuario
//                 },
//               ],
//               Subject: "Atención: Tu banco necesita confirmar este pago",
//               TextPart: `Hola ${user.firstName}, el pago de tu suscripción falló. Tu banco necesita una autorizacion para procesar este pago`,
//               HTMLPart: `
//               <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px; background-color: #F7F7F7;">
//                 <h3 style="color: #FF4C4C; margin-bottom: 10px;">Hola ${user.firstName},</h3>
//                 <img src="https://bluenova.s3.us-east-2.amazonaws.com/Cara-Sad-Logout.png" alt="Imagen de pago fallido" style="width: 80%; max-width: 400px; height: auto; border-radius: 10px; margin-bottom: 20px;"/>
//                 <p style="font-size: 18px; color: #333; margin-bottom: 20px;">
//                     Hola ${user.firstName}, el pago de tu suscripción falló. Tu banco necesita una autorizacion para procesar este pago, tienes 24 horas para poder aturoizarte.
//                 </p>
//                 <p style="font-size: 16px; color: #007BFF; margin-bottom: 20px;">
//                    <a href="https://mentorai.netlify.app/" style="text-decoration: none; color: #007BFF; font-weight: bold;">Haz clic aquí para actualizar tu método de pago</a>
//                 </p>
//                 <p style="font-size: 14px; color: #555; margin-top: 20px;">
//                     Si necesitas ayuda o tienes alguna pregunta, no dudes en contactarnos. Estamos aquí para asistirte.
//                 </p>
//                 <p style="font-size: 14px; color: #777; margin-top: 20px;">
//                     Saludos,<br/>
//                     <strong>El equipo de NOVA AI</strong>
//                 </p>
//             </div>
//                 `,
//             },
//           ],
//         });

//         // Manejo de la respuesta del envío de email
//         request
//           .then((result) => {
//             console.log("Correo enviado exitosamente:", result.body);
//           })
//           .catch((err) => {
//             console.error("Error al enviar el correo:", err.statusCode);
//           });

//         // Notificar al frontend que se requiere 3D Secure
//         return res.json({
//           message: "3D Secure required",
//           clientSecret: paymentIntent.client_secret, // Envías el `client_secret` al frontend
//         });
//       }
//     }

//     // Manejar el evento de pago fallido
//     if (event.type === "invoice.payment_failed") {
//       const invoice = event.data.object;
//       const customerId = invoice.customer;

//       try {
//         // Buscar al usuario en la base de datos con su customerId de Stripe
//         const user = await User.findOne({ customerIdStripe: customerId });

//         if (user) {
//           // Enviar correo al usuario notificando que su pago falló
//           const request = mailjet.post("send", { version: "v3.1" }).request({
//             Messages: [
//               {
//                 From: {
//                   Email: "novaappai@gmail.com", // Cambia a tu correo
//                   Name: "NOVA AI", // Nombre que aparecerá como remitente
//                 },
//                 To: [
//                   {
//                     Email: user.email, // Email del usuario (se obtiene desde la base de datos)
//                     Name: `${user.firstName} ${user.lastName}`, // Nombre completo del usuario
//                   },
//                 ],
//                 Subject:
//                   "Atención: Hubo un problema con el pago de tu suscripción",
//                 TextPart: `Hola ${user.firstName}, el pago de tu suscripción falló. Por favor, actualiza tu método de pago.`,
//                 HTMLPart: `
//                 <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px; background-color: #F7F7F7;">
//                   <h3 style="color: #FF4C4C; margin-bottom: 10px;">Hola ${user.firstName},</h3>
//                   <img src="https://bluenova.s3.us-east-2.amazonaws.com/Cara-Sad-Logout.png" alt="Imagen de pago fallido" style="width: 80%; max-width: 400px; height: auto; border-radius: 10px; margin-bottom: 20px;"/>
//                   <p style="font-size: 18px; color: #333; margin-bottom: 20px;">
//                       El pago de tu suscripción ha fallado. Para evitar interrupciones en tu acceso, te recomendamos <strong>actualizar tu método de pago</strong> lo antes posible.
//                   </p>
//                   <p style="font-size: 16px; color: #007BFF; margin-bottom: 20px;">
//                       <a href="https://mentorai.netlify.app/checkoutUpdate" style="text-decoration: none; color: #007BFF; font-weight: bold;">Haz clic aquí para actualizar tu método de pago</a>
//                   </p>
//                   <p style="font-size: 14px; color: #555; margin-top: 20px;">
//                       Si necesitas ayuda o tienes alguna pregunta, no dudes en contactarnos. Estamos aquí para asistirte.
//                   </p>
//                   <p style="font-size: 14px; color: #777; margin-top: 20px;">
//                       Saludos,<br/>
//                       <strong>El equipo de NOVA AI</strong>
//                   </p>
//               </div>
//                   `,
//               },
//             ],
//           });

//           // Manejo de la respuesta del envío de email
//           request
//             .then((result) => {
//               console.log("Correo enviado exitosamente:", result.body);
//             })
//             .catch((err) => {
//               console.error("Error al enviar el correo:", err.statusCode);
//             });
//         } else {
//           console.log("Usuario no encontrado para el customerId:", customerId);
//         }
//       } catch (error) {
//         console.error("Error buscando usuario o enviando correo:", error);
//       }
//     } else if (event.type === "invoice.payment_succeeded") {
//       const invoice = event.data.object;
//       const customerId = invoice.customer;

//       try {
//         // Buscar al usuario en la base de datos con su customerId de Stripe
//         const user = await User.findOne({ customerIdStripe: customerId });

//         if (user) {
//           // Enviar correo al usuario notificando que su pago fue exitoso
//           user.secretKeyStripe = null;
//           await user.save();
//           const request = mailjet.post("send", { version: "v3.1" }).request({
//             Messages: [
//               {
//                 From: {
//                   Email: "novaappai@gmail.com", // Cambia a tu correo
//                   Name: " Nova AI", // Nombre que aparecerá como remitente
//                 },
//                 To: [
//                   {
//                     Email: user.email, // Email del usuario (se obtiene desde la base de datos)
//                     Name: `${user.firstName} ${user.lastName}`, // Nombre completo del usuario
//                   },
//                 ],
//                 Subject: "¡Bienvenido!",
//                 TextPart: `Hola ${user.firstName}, ¡Bienvenido a NOVA AI! Estamos emocionados de que te unas a nosotros.`,
//                 HTMLPart: `
//                           <h3>Hola ${user.firstName},</h3>
//                           <img src="https://bluenova.s3.us-east-2.amazonaws.com/Cara-Sad-Login.png" alt="Nova te da la bienvenida" style="width: 100%; max-width: 400px; height: auto; border-radius: 10px; margin-bottom: 20px;"/>
//                           <p>¡Gracias por unirte a NOVA AI! Estamos emocionados de que formes parte de nuestra comunidad. Prepárate para explorar nuevas maneras de aprender y crecer con nosotros.</p>
//                           <p>Si tienes alguna pregunta o necesitas ayuda, no dudes en contactarnos.</p>
//                           <p style="font-size: 14px; color: #666666; margin-top: 20px;">
//                             Un saludo,<br/>
//                             <strong>El equipo de NOVA AI</strong>
//                         </p>
//                         `,
//               },
//             ],
//           });

//           request
//             .then((result) => {
//               console.log("Correo enviado exitosamente:", result.body);
//             })
//             .catch((err) => {
//               console.error("Error al enviar el correo:", err.statusCode);
//             });
//         } else {
//           console.log("Usuario no encontrado para el customerId:", customerId);
//         }
//       } catch (error) {
//         console.error("Error buscando usuario o enviando correo:", error);
//       }
//     }
//     // Responder a Stripe que el evento fue recibido correctamente
//     res.status(200).json({ received: true });
//   }
// );

app.use(
  "/webhook",
  express.raw({ type: "application/json" }),
  require("./routes/webhook"),
);

app.use(helmet());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));
app.use(cors());

const endpointSecret = process.env.WEB_HOOK_STRIPE;

// Every request runs inside an AI-usage context, so a Claude call made three
// layers down still knows whose spend it is. Filled in by `protect` once the
// user is known.
app.use((req, res, next) => require("./services/aiUsageService").runWith({}, next));

app.use("/api/user", require("./routes/userRoutes"));
app.use("/api/company", require("./routes/companyRoutes"));
app.use("/api/checkout", require("./routes/checkoutRoutes"));
app.use("/api/inventory", require("./routes/inventoryRoutes"));
app.use("/api/order", require("./routes/orderRoutes"));
app.use("/api/docs", require("./routes/docRoutes"));
app.use("/api/github", require("./routes/githubRoutes"));
app.use("/api/mcp-lab", require("./routes/mcpLabRoutes"));
app.use("/api/qa", require("./routes/apiQARoutes"));
app.use("/api/qa-report", require("./routes/qaReportRoutes"));
app.use("/api/usage", require("./routes/usageRoutes"));
app.use("/api/admin", require("./routes/adminRoutes"));
app.use("/api/e2e", require("./routes/e2eQaRoutes"));
app.use("/api/installations", require("./routes/installationsRoutes"));
app.use("/api/example", require("./routes/exampleRoutes"));
app.use("/api/watchers", require("./routes/watcherRoutes"));
app.use("/api/mcp-watchers", require("./routes/mcpWatcherRoutes"));

app.use((req, res) => res.status(404).json({ message: 'Route not found' }))
app.use(errorHandler);

// app.listen(port, () => console.log(`Server started on port ${port}`));
if (process.env.NODE_ENV !== "test") {
  app.listen(port, "0.0.0.0", () => {
    console.log(`Server started on port ${port}`);

    // Pick up watcher runs that a previous process recorded but never finished.
    // A merge that lands while this service is redeploying gets its trigger
    // written to the database and its work killed a second later; without this
    // the run is lost with no trace beyond a 200 in GitHub's delivery log.
    // Delayed so it never competes with the first real requests after a boot.
    setTimeout(() => {
      require("./services/watcherService")
        .drainPendingRuns()
        .catch((err) =>
          console.error("[watcher] could not resume pending runs:", err.message),
        );
      // MCP runs too — those can be minutes into waiting for a deploy when the
      // process goes down, which makes resuming them matter even more.
      require("./services/mcpWatcherService")
        .drainPendingRuns()
        .catch((err) =>
          console.error("[mcp-watcher] could not resume pending runs:", err.message),
        );
    }, 10000);
  });
}
// resetLoginDaysJob();
// scrapMarinasApify();
module.exports = app;
