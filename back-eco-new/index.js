const express = require("express");
const WebSocket = require("ws");
const admin = require("firebase-admin");
const cors = require("cors");

// Firebase setup
const serviceAccount = require("./encurta-c3642-firebase-adminsdk-fbsvc-a8b869d0d1.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json()); // Adicionado pra parsear JSON no body dos POSTs

app.get("/health", (req, res) => res.status(200).send("Servidor OK"));

// NOVO ENDPOINT: Cria ou retorna chat existente baseado em participants e produtoId
app.post("/create-chat", async (req, res) => {
  const { participants, produtoId, produtoNome, usuariosInfo } = req.body;

  if (!participants || participants.length < 2 || !produtoId) {
    return res.status(400).json({
      error:
        "Faltam dados: participants (array com pelo menos 2 UIDs), produtoId obrigatório!",
    });
  }

  try {
    // Busca se já existe um chat com EXATAMENTE esses participants e produtoId
    const chatsRef = db.collection("chats");
    const snapshot = await chatsRef
      .where("participants", "array-contains-any", participants)
      .where("produtoId", "==", produtoId)
      .get();

    let existingChat = null;
    snapshot.forEach((doc) => {
      const data = doc.data();
      // Checa se participants batem EXATAMENTE (ordem não importa)
      if (
        data.participants &&
        data.participants.sort().join() === participants.sort().join()
      ) {
        existingChat = { id: doc.id, ...data };
      }
    });

    if (existingChat) {
      console.log(
        `🔄 Chat existente encontrado para produtoId ${produtoId}: ${existingChat.id}`
      );
      return res.json({
        chatId: existingChat.id,
        message: "Chat existente retornado!",
      });
    }

    // Se não existe, cria um novo
    const newChatRef = chatsRef.doc();
    const newChatData = {
      participants,
      produtoId,
      produtoNome: produtoNome || "Produto sem nome",
      usuariosInfo: usuariosInfo || {},
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      lastMessage: "",
      lastMessageTimestamp: admin.firestore.FieldValue.serverTimestamp(),
    };
    await newChatRef.set(newChatData);

    console.log(
      `🆕 Novo chat criado para produtoId ${produtoId}: ${newChatRef.id}`
    );
    return res.json({ chatId: newChatRef.id, message: "Novo chat criado!" });
  } catch (err) {
    console.error("❌ Erro ao criar/checagem de chat:", err);
    return res.status(500).json({ error: "Erro interno ao processar chat!" });
  }
});

const server = app.listen(8080, () =>
  console.log("🟢 Servidor rodando na porta 8080")
);

const wss = new WebSocket.Server({ server });

function sendJson(ws, data) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  } catch (err) {
    console.error("❌ Erro ao enviar JSON via WebSocket:", err);
  }
}

wss.on("connection", (ws, req) => {
  const urlParams = new URLSearchParams(
    req.url.substring(req.url.indexOf("?"))
  );
  const chatId = urlParams.get("chatId");
  const userUid = urlParams.get("userUid");

  if (!chatId || !userUid) {
    console.log("⛔ Conexão WebSocket rejeitada: Faltam chatId ou userUid.");
    return ws.close();
  }

  ws.chatId = chatId;
  ws.userUid = userUid;
  console.log(`🔗 Cliente ${userUid} conectado ao chat ${chatId}`);

  // PATCH: Sempre sinc usuariosInfo ao conectar:
  (async () => {
    try {
      const chatRef = db.collection("chats").doc(chatId);
      const chatSnap = await chatRef.get();
      if (!chatSnap.exists) return;

      const chatData = chatSnap.data();
      const participantes = chatData.participants || [];
      let usuariosInfoAtualizado = { ...chatData.usuariosInfo } || {};
      for (const uid of participantes) {
        try {
          const userSnap = await db.collection("usuarios").doc(uid).get();
          if (userSnap.exists) {
            const d = userSnap.data();
            usuariosInfoAtualizado[uid] = {
              nome: d.nome || "Usuário",
              foto: d.foto || "",
            };
          }
        } catch (e) {
          if (!usuariosInfoAtualizado[uid]) {
            usuariosInfoAtualizado[uid] = { nome: "Usuário", foto: "" };
          }
        }
      }
      if (
        JSON.stringify(chatData.usuariosInfo) !==
        JSON.stringify(usuariosInfoAtualizado)
      ) {
        await chatRef.set(
          { usuariosInfo: usuariosInfoAtualizado },
          { merge: true }
        );
        console.log(
          "🟢 usuariosInfo do chat sincronizado ao conectar:",
          chatId,
          usuariosInfoAtualizado
        );
      }
    } catch (err) {
      console.error("❌ Erro ao atualizar usuariosInfo no onConnection:", err);
    }
  })();

  // Salva status online no Firestore (presencas/{userUid})
  db.collection("presencas")
    .doc(userUid)
    .set(
      {
        online: true,
        ultimoAcesso: admin.firestore.FieldValue.serverTimestamp(),
        chatIdAtual: chatId,
      },
      { merge: true }
    )
    .then(() =>
      console.log(
        `🟢 [PRESENÇA] Usuário ${userUid} marcado como ONLINE no Firestore`
      )
    )
    .catch((err) =>
      console.error(
        `❌ [PRESENÇA] Falha ao marcar ${userUid} como online:`,
        err
      )
    );

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.chatId === chatId) {
      sendJson(client, { type: "user_online", userUid });
    }
  });

  db.collection("chats")
    .doc(chatId)
    .collection("messages")
    .orderBy("timestamp", "asc")
    .get()
    .then((snapshot) => {
      const messages = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));
      console.log(
        `📩 Enviando ${messages.length} mensagens de histórico para ${userUid} no chat ${chatId}`
      );
      sendJson(ws, { type: "history", messages });
    })
    .catch((err) => console.error("❌ Erro ao buscar histórico:", err));

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.log("⚠️ Mensagem malformada recebida e ignorada:", raw);
      return;
    }

    // LOGA TUDO QUE CHEGA DO CLIENTE
    console.log("🗳️ Payload recebido:", JSON.stringify(msg, null, 2));

    // --- NOVO: handler para fechamento de chat! ---
    if (msg.type === "close_chat") {
      console.log("⛔️ Evento 'close_chat' recebido!");
      try {
        const chatRef = db.collection("chats").doc(ws.chatId);

        // Apaga todas as mensagens do chat
        const msgsSnap = await chatRef.collection("messages").get();
        const batch = db.batch();
        msgsSnap.forEach((doc) => batch.delete(doc.ref));
        await batch.commit();

        // Apaga o documento do chat
        await chatRef.delete();

        // Notifica todos os clientes conectados no chat
        wss.clients.forEach((client) => {
          if (
            client.readyState === WebSocket.OPEN &&
            client.chatId === ws.chatId
          ) {
            sendJson(client, {
              type: "chat_closed",
              closedBy: ws.userUid,
              closedByName: msg.fromName || "Alguém",
            });
          }
        });
        console.log("✅ Chat removido e broadcast enviado!");
      } catch (err) {
        console.error("❌ Erro ao encerrar chat:", err);
        sendJson(ws, { type: "error", error: "Falha ao encerrar chat!" });
      }
      return; // NÃO continue processando como mensagem normal!
    }

    if (msg.type !== "message") {
      console.log(
        `ℹ️ Evento '${msg.type}' recebido de ${ws.userUid} em ${ws.chatId}`
      );
      return;
    }

    const { from, fromName, text, timestamp, replyTo, produtoId, produtoNome } =
      msg;
    const fromPhotoURL = msg.fromPhotoURL || "";

    // LOGA OS DADOS BÁSICOS DO ENVIO
    console.log(
      `🧾 Dados mensagem recebida > from: ${from} | nome: ${fromName} | foto: ${fromPhotoURL}`
    );

    if (!from || !text || !text.trim()) {
      console.log("❗ Mensagem inválida recebida! Enviando erro para cliente.");
      return sendJson(ws, { type: "error", error: "Mensagem inválida" });
    }

    try {
      const chatRef = db.collection("chats").doc(ws.chatId);
      const chatSnap = await chatRef.get();
      let chatData = chatSnap.exists ? chatSnap.data() : {};
      let participantes = chatData.participants || [from];
      if (!participantes.includes(from)) participantes.push(from);

      // Descobre o outro participante
      let otherUid = participantes.find((uid) => uid !== from) || null;

      // Atualiza e LOGA info dos participantes
      let usuariosInfoAtualizado = Object.assign(
        {},
        chatData.usuariosInfo || {}
      );
      // Atualiza o remetente (quem está enviando)
      usuariosInfoAtualizado[from] = {
        nome: fromName || "Anônimo",
        foto: fromPhotoURL,
      };

      console.log(
        `🟦 [USUARIO] PARTICIPANTE FROM > uid: ${from} | nome: ${fromName} | foto: ${fromPhotoURL}`
      );

      // Atualiza/recupera info do outro
      if (
        otherUid &&
        (!usuariosInfoAtualizado[otherUid] ||
          !usuariosInfoAtualizado[otherUid].nome)
      ) {
        try {
          const userSnap = await db.collection("usuarios").doc(otherUid).get();
          if (userSnap.exists) {
            const info = userSnap.data();
            usuariosInfoAtualizado[otherUid] = {
              nome: info.nome || "Usuário",
              foto: info.foto || "",
            };
            console.log(
              `🟩 [USUARIO] PARTICIPANTE OUTRO > uid: ${otherUid} | nome: ${
                info.nome || "Usuário"
              } | foto: ${info.foto || ""}`
            );
          } else {
            usuariosInfoAtualizado[otherUid] = {
              nome: "Usuário",
              foto: "",
            };
            console.log(
              `🟧 [USUARIO] PARTICIPANTE OUTRO NÃO ENCONTRADO > uid: ${otherUid}`
            );
          }
        } catch (err) {
          usuariosInfoAtualizado[otherUid] = {
            nome: "Usuário",
            foto: "",
          };
          console.error(
            `❌ [USUARIO] Erro ao buscar dados do participante ${otherUid}:`,
            err
          );
        }
      }

      let payload = {
        lastMessage: text,
        lastMessageTimestamp:
          timestamp || admin.firestore.FieldValue.serverTimestamp(),
        usuariosInfo: usuariosInfoAtualizado,
      };

      if (produtoId) {
        console.log(`📝 Recebido produtoId do front: "${produtoId}"`);
        payload.produtoId = produtoId;
      }
      if (produtoNome) {
        console.log(`📝 Recebido produtoNome do front: "${produtoNome}"`);
        payload.produtoNome = produtoNome;
      }

      await chatRef.set(payload, { merge: true });
      console.log(
        `✔️ Chat ${ws.chatId} atualizado com nova mensagem, usuariosInfo completo e possíveis campos de produto`
      );

      console.log(
        "📦 usuariosInfo gravado:",
        JSON.stringify(payload.usuariosInfo, null, 2)
      );

      const msgObj = {
        from,
        fromName,
        fromPhotoURL,
        text,
        timestamp,
        replyTo: replyTo || null,
      };
      const messageDoc = await chatRef.collection("messages").add(msgObj);
      const messageWithId = {
        type: "message",
        id: messageDoc.id,
        ...msgObj,
        fromName: usuariosInfoAtualizado[from]?.nome || "Usuário",
        fromPhotoURL: usuariosInfoAtualizado[from]?.foto || "",
      };

      console.log(
        `💬 Mensagem adicionada à subcoleção [${messageDoc.id}]:`,
        msgObj
      );

      wss.clients.forEach((client) => {
        if (
          client.readyState === WebSocket.OPEN &&
          client.chatId === ws.chatId
        ) {
          sendJson(client, messageWithId);
        }
      });
      console.log(
        "🔊 Mensagem broadcast para todos clientes conectados neste chat."
      );
    } catch (err) {
      console.error("❌ Erro ao processar mensagem:", err);
      sendJson(ws, { type: "error", error: "Erro interno ao enviar mensagem" });
    }
  });

  ws.on("close", () => {
    console.log(`🔌 Cliente ${userUid} desconectado do chat ${chatId}`);

    db.collection("presencas")
      .doc(userUid)
      .set(
        {
          online: false,
          ultimoAcesso: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
      .then(() =>
        console.log(
          `⚫ [PRESENÇA] Usuário ${userUid} marcado como OFFLINE no Firestore`
        )
      )
      .catch((err) =>
        console.error(
          `❌ [PRESENÇA] Falha ao marcar ${userUid} como offline:`,
          err
        )
      );

    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN && client.chatId === chatId) {
        sendJson(client, { type: "user_offline", userUid });
      }
    });
  });

  ws.on("error", (error) =>
    console.error(`❌ Erro no WebSocket [${chatId}]:`, error)
  );
});

// Ping-pong para manter a conexão viva
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log("⏰ WebSocket morto, desconectando...");
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });
});
