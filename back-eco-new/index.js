// Importações necessárias
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago");

// --- INICIALIZAÇÃO DO FIREBASE ADMIN ---
// Lembre-se de colocar suas credenciais em variáveis de ambiente em produção!
admin.initializeApp({
  credential: admin.credential.cert(
    require("./morada-9bf09-firebase-adminsdk-fbsvc-57c56fbb53.json")
  ),
});
const db = admin.firestore();

// --- CONFIGURAÇÃO DO MERCADO PAGO ---
// Lembre-se de colocar seu accessToken em variáveis de ambiente em produção!
const client = new MercadoPagoConfig({
  accessToken:
    "APP_USR-6065328443726252-090714-2afc6bf90c49eb38bf2c076b0737f515-2678129866",
});
const preference = new Preference(client);

// --- CONFIGURAÇÃO DO EXPRESS ---
const app = express();
app.use(cors());
app.use(express.json());
app.get("/teste-servidor", (req, res) => {
  console.log("ROTA /teste-servidor FOI CHAMADA COM SUCESSO!");
  res
    .status(200)
    .json({ message: "Olá! O servidor está no ar e esta rota funciona!" });
});
// =================================================================
// ROTA DE PAGAMENTO (SIMPLIFICADA E CORRIGIDA)
// =================================================================

app.post("/criar-pagamento", async (req, res) => {
  try {
    const { lugarId, checkin, checkout, usuarioUid, nome, email } = req.body;
    const taxaPlataformaPercentual = 0.01;
    // 1. Você pega o lugarId que o frontend enviou
    const lugarRef = db.collection("lugares").doc(lugarId);

    // 2. Você procura esse ID no Firestore
    const lugarDoc = await lugarRef.get();

    // 3. E AQUI ESTÁ O PULO DO GATO:
    if (!lugarDoc.exists) {
      // Se o documento NÃO EXISTE, você mesmo retorna um erro 404!
      return res.status(404).json({ error: "Lugar não encontrado." });
    }
    const lugarData = lugarDoc.data();
    const precoPorNoite = lugarData.preco || 0;

    const checkinDate = new Date(checkin);
    const checkoutDate = new Date(checkout);
    const diffTime = Math.abs(checkoutDate - checkinDate);
    const diffDays = Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
    const precoBase = precoPorNoite * diffDays;
    const comissao = parseFloat(
      (precoBase * taxaPlataformaPercentual).toFixed(2)
    );
    const precoFinalCliente = precoBase + comissao;

    const novaReservaRef = await db.collection("reservas").add({
      lugarId,
      anfitriaoUid: lugarData.anfitriao.uid,
      usuarioUid,
      checkin: admin.firestore.Timestamp.fromDate(checkinDate),
      checkout: admin.firestore.Timestamp.fromDate(checkoutDate),
      precoTotal: precoFinalCliente,
      comissaoPlataforma: comissao,
      status: "AGUARDANDO_PAGAMENTO",
      criadoEm: admin.firestore.FieldValue.serverTimestamp(),
    });

    const preferenceBody = {
      items: [
        {
          id: novaReservaRef.id,
          title: `Reserva para: ${lugarData.nome}`,
          description: `Taxa de serviço inclusa`,
          quantity: 1,
          currency_id: "BRL",
          unit_price: precoFinalCliente,
        },
      ],
      payer: {
        name: nome,
        email: email, // Este email vem do frontend
      },
      back_urls: {
        success: `http://localhost/minhas-reservas.html?status=success&reserva_id=${novaReservaRef.id}`,
        failure: `http://localhost/detalhes.html?id=${lugarId}&status=failure`,
        pending: `http://localhost/minhas-reservas.html?status=pending&reserva_id=${novaReservaRef.id}`,
      },
      external_reference: novaReservaRef.id,
      notification_url: "https://SUA_URL_PUBLICA_DO_BACKEND/webhook-pagamento",
    };

    console.log("--- PREFERENCE SIMPLIFICADA ENVIADA PARA O MERCADO PAGO ---");
    console.log(JSON.stringify(preferenceBody, null, 2));

    const result = await preference.create({ body: preferenceBody });
    res.json({ preferenceId: result.id, init_point: result.init_point });
  } catch (error) {
    console.error("Erro ao criar pagamento:", error.cause || error.message);
    res.status(500).json({ error: "Falha ao criar o pagamento." });
  }
});

// =================================================================
// ROTA PARA CHECK-OUT (LÓGICA DE ATUALIZAÇÃO DE STATUS)
// =================================================================
app.post("/liberar-pagamento/:reservaId", async (req, res) => {
  try {
    const { reservaId } = req.params;
    const { usuarioUid } = req.body;

    const reservaRef = db.collection("reservas").doc(reservaId);
    const reservaDoc = await reservaRef.get();

    if (!reservaDoc.exists) {
      return res.status(404).json({ error: "Reserva não encontrada." });
    }
    const reservaData = reservaDoc.data();

    if (
      reservaData.usuarioUid !== usuarioUid &&
      reservaData.anfitriaoUid !== usuarioUid
    ) {
      return res.status(403).json({ error: "Ação não permitida." });
    }
    if (reservaData.status !== "em-andamento") {
      return res.status(400).json({
        error: "A reserva precisa estar 'em andamento' para fazer o check-out.",
      });
    }
    if (!reservaData.paymentId) {
      return res
        .status(400)
        .json({ error: "Pagamento não encontrado na reserva." });
    }

    await reservaRef.update({
      status: "finalizada",
      checkoutRealizadoEm: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(
      `Check-out confirmado para reserva ${reservaId}. O repasse para o anfitrião deve ser feito manualmente.`
    );

    res.status(200).json({
      message:
        "Check-out confirmado. O repasse para o anfitrião será processado.",
    });
  } catch (error) {
    console.error(
      "Erro ao finalizar reserva (check-out):",
      error.cause || error.message
    );
    res.status(500).json({ error: "Falha ao processar o check-out." });
  }
});

// =================================================================
// ROTAS DE WEBHOOK, USUÁRIOS E DENÚNCIAS
// =================================================================

app.post("/webhook-pagamento", async (req, res) => {
  try {
    const { body } = req;
    if (body.type === "payment") {
      const paymentId = body.data.id;
      const payment = await new Payment(client).get({ id: paymentId });
      const reservaId = payment.external_reference;

      if (reservaId) {
        const reservaRef = db.collection("reservas").doc(reservaId);
        let novoStatus = "AGUARDANDO_PAGAMENTO";

        if (payment.status === "approved") {
          novoStatus = "PAGAMENTO_CONFIRMADO";
        } else if (["rejected", "cancelled"].includes(payment.status)) {
          novoStatus = "PAGAMENTO_FALHOU";
        }

        await reservaRef.update({
          status: novoStatus,
          paymentId: paymentId,
        });
        console.log(
          `Webhook: Reserva ${reservaId} atualizada para ${novoStatus}.`
        );
      }
    }
    res.status(200).send("ok");
  } catch (error) {
    console.error("Erro no webhook:", error);
    res.status(500).send("error");
  }
});

app.get("/usuario/:uid", async (req, res) => {
  try {
    const { uid } = req.params;
    const userRecord = await admin.auth().getUser(uid);
    const userDoc = await db.collection("usuarios").doc(uid).get();
    if (userDoc.exists && userDoc.data().banido) {
      return res.status(403).json({ error: "Usuário banido." });
    }
    const firestoreData = userDoc.exists ? userDoc.data() : {};
    const usuario = {
      uid: userRecord.uid,
      displayName: userRecord.displayName,
      email: userRecord.email,
      photoURL: userRecord.photoURL,
      bio: firestoreData.bio || null,
      telefone: firestoreData.telefone || null,
      createdAt: userRecord.metadata.creationTime,
      lastLogin: userRecord.metadata.lastSignInTime,
    };
    res.json(usuario);
  } catch (error) {
    if (error.code === "auth/user-not-found") {
      res.status(404).json({ error: "Usuário não encontrado." });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

app.get("/usuarios", async (req, res) => {
  try {
    let lista = [];
    const authResult = await admin.auth().listUsers(1000);
    const usersUids = authResult.users.map((u) => u.uid);
    const firestoreSnapshots = await db
      .collection("usuarios")
      .where(admin.firestore.FieldPath.documentId(), "in", usersUids)
      .get();
    const firestoreData = {};
    firestoreSnapshots.forEach((doc) => {
      firestoreData[doc.id] = doc.data();
    });
    authResult.users.forEach((userRecord) => {
      const extraData = firestoreData[userRecord.uid] || {};
      if (!extraData.banido) {
        lista.push({
          uid: userRecord.uid,
          displayName: userRecord.displayName,
          email: userRecord.email,
          photoURL: userRecord.photoURL,
          bio: extraData.bio || null,
          telefone: extraData.telefone || null,
          createdAt: userRecord.metadata.creationTime,
          lastLogin: userRecord.metadata.lastSignInTime,
        });
      }
    });
    res.json(lista);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/denuncia", async (req, res) => {
  try {
    const { usuarioId, denuncianteUid, motivo, detalhes } = req.body;
    if (!usuarioId || !denuncianteUid || !motivo) {
      return res.status(400).json({ error: "Campos obrigatórios ausentes." });
    }
    const denunciaExistente = await db
      .collection("denuncias")
      .where("usuarioId", "==", usuarioId)
      .where("denuncianteUid", "==", denuncianteUid)
      .get();
    if (!denunciaExistente.empty) {
      return res.status(400).json({ error: "Você já denunciou este usuário." });
    }
    const denunciaData = {
      usuarioId,
      denuncianteUid,
      motivo,
      detalhes: detalhes || "",
      criadoEm: admin.firestore.FieldValue.serverTimestamp(),
      status: "EM_ANALISE",
    };
    await db.collection("denuncias").add(denunciaData);
    const denunciasSnapshot = await db
      .collection("denuncias")
      .where("usuarioId", "==", usuarioId)
      .get();
    const denunciasUnicas = new Set(
      denunciasSnapshot.docs.map((doc) => doc.data().denuncianteUid)
    ).size;
    const usuarioRef = db.collection("usuarios").doc(usuarioId);
    await usuarioRef.set({ totalDenuncias: denunciasUnicas }, { merge: true });
    if (denunciasUnicas >= 12) {
      await usuarioRef.set({ banido: true }, { merge: true });
      await admin.auth().updateUser(usuarioId, { disabled: true });
    }
    res.status(200).json({ message: "Denúncia registrada com sucesso." });
  } catch (error) {
    console.error("Erro ao registrar denúncia:", error);
    res.status(500).json({ error: "Erro interno ao processar denúncia." });
  }
});

app.get("/denuncias/denunciante/:uid", async (req, res) => {
  try {
    const { uid } = req.params;
    const snapshot = await db
      .collection("denuncias")
      .where("denuncianteUid", "==", uid)
      .orderBy("criadoEm", "desc")
      .get();
    const denuncias = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
        status: data.status || "EM_ANALISE",
        criadoEm: data.criadoEm?.toDate() || null,
      };
    });
    res.status(200).json(denuncias);
  } catch (error) {
    console.error("Erro ao buscar denúncias:", error);
    res.status(500).json({ error: "Erro ao buscar denúncias." });
  }
});

app.get("/denuncias", async (req, res) => {
  try {
    const { status } = req.query;
    let query = db.collection("denuncias");
    if (status) {
      query = query.where("status", "==", status);
    }
    const snapshot = await query.orderBy("criadoEm", "desc").get();
    const denuncias = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
        status: data.status || "EM_ANALISE",
        criadoEm: data.criadoEm?.toDate() || null,
      };
    });
    res.status(200).json(denuncias);
  } catch (error) {
    console.error("Erro ao buscar todas as denúncias:", error);
    res.status(500).json({ error: "Erro ao buscar denúncias." });
  }
});

app.post("/denuncia/:id/responder", async (req, res) => {
  try {
    const { id } = req.params;
    const { acao, respostaAdmin, banirUsuario } = req.body;
    if (!acao || !respostaAdmin) {
      return res
        .status(400)
        .json({ error: "Ação e resposta são obrigatórias." });
    }
    const denunciaRef = db.collection("denuncias").doc(id);
    const denunciaDoc = await denunciaRef.get();
    if (!denunciaDoc.exists) {
      return res.status(404).json({ error: "Denúncia não encontrada." });
    }
    const novoStatus = acao === "ACATAR" ? "RESOLVIDA" : "REJEITADA";
    await denunciaRef.update({
      status: novoStatus,
      respostaAdmin: respostaAdmin,
      respondidoEm: admin.firestore.FieldValue.serverTimestamp(),
    });
    if (banirUsuario) {
      const usuarioId = denunciaDoc.data().usuarioId;
      const usuarioRef = db.collection("usuarios").doc(usuarioId);
      await usuarioRef.set({ banido: true }, { merge: true });
      await admin.auth().updateUser(usuarioId, { disabled: true });
    }
    res.status(200).json({ message: "Denúncia respondida com sucesso." });
  } catch (error) {
    console.error("Erro ao responder denúncia:", error);
    res.status(500).json({ error: "Erro ao responder denúncia." });
  }
});

// =================================================================
// ROTA DE TESTE MINIMALISTA - VERSÃO FINAL CORRIGIDA
// =================================================================
app.get("/teste-pagamento-minimo", async (req, res) => {
  try {
    const preferenceBody = {
      items: [
        {
          title: "Produto de Teste Minimalista",
          description: "Teste de pagamento direto",
          quantity: 1,
          currency_id: "BRL",
          unit_price: 75.5,
        },
      ],
      payer: {
        // Use o e-mail do seu comprador de teste oficial
        email: "test_user_2678129888@testuser.com",
      },
      back_urls: {
        success: "https://www.google.com.br?status=success",
        failure: "https://www.google.com.br?status=failure",
        pending: "https://www.google.com.br?status=pending",
      },
      external_reference: `teste-minimalista-${Date.now()}`,
    };

    console.log("--- PREFERENCE FINAL CORRIGIDA ---");
    console.log(JSON.stringify(preferenceBody, null, 2));

    const result = await preference.create({ body: preferenceBody });

    res.redirect(result.init_point);
  } catch (error) {
    console.error("Erro no teste minimalista:", error.cause || error.message);
    res.status(500).json({ error: "Falha no teste minimalista." });
  }
});

// --- INICIAR SERVIDOR ---
const PORT = process.env.PORT || 8080;
app.listen(PORT, () =>
  console.log(`Servidor rodando na porta http://localhost:${PORT}`)
);
