import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";
import authRouter, {
  authRequired,
  verifySocketJWT,
} from "./middleware/auth.js";
import User from "./models/User.js";
import Game from "./models/Game.js";
import { Chess } from "chess.js";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

const io = new SocketIOServer(server, {
  cors: {
    origin: process.env.CLIENT_ORIGIN || "*",
    methods: ["GET", "POST"],
  },
});

app.use(cors({ origin: process.env.CLIENT_ORIGIN || "*", credentials: true }));
app.use(express.json());

// --- MongoDB ---
mongoose
  .connect(
    process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/chess_realtime"
  )
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB error:", err.message));

// --- Auth Routes ---
app.use("/api/auth", authRouter);

// --- Example protected route ---
app.get("/api/me", authRequired, async (req, res) => {
  const me = await User.findById(req.user.id).select("-password");
  res.json(me);
});

// --- Static client ---
app.use(express.static(path.join(__dirname, "public")));

// --- In-memory matchmaking queue ---
let waitingQueue = []; // [{ userId, socketId, username }]

io.use(verifySocketJWT);

io.on("connection", (socket) => {
  const userId = socket.user?.id;
  const username = socket.user?.username;
  console.log("Socket connected:", socket.id, username);

  socket.on("joinQueue", async () => {
    // already queued?
    if (!waitingQueue.find((q) => q.userId === userId)) {
      waitingQueue.push({ userId, socketId: socket.id, username });
      socket.emit("queued");
    }
    if (waitingQueue.length >= 2) {
      const p1 = waitingQueue.shift();
      const p2 = waitingQueue.shift();
      const assignWhite = Math.random() < 0.5 ? p1 : p2;
      const assignBlack = assignWhite === p1 ? p2 : p1;

      const chess = new Chess();
      const game = await Game.create({
        white: assignWhite.userId,
        black: assignBlack.userId,
        fen: chess.fen(),
        moves: [],
        status: "active",
      });

      const room = String(game._id);
      io.sockets.sockets.get(p1.socketId)?.join(room);
      io.sockets.sockets.get(p2.socketId)?.join(room);

      io.to(p1.socketId).emit("gameStart", {
        gameId: room,
        color: assignWhite === p1 ? "w" : "b",
        fen: game.fen,
      });
      io.to(p2.socketId).emit("gameStart", {
        gameId: room,
        color: assignWhite === p2 ? "w" : "b",
        fen: game.fen,
      });
    }
  });

  socket.on("move", async ({ gameId, from, to, promotion }) => {
    try {
      const game = await Game.findById(gameId);
      if (!game || game.status !== "active") return;
      const isWhite = String(game.white) === String(userId);
      const isBlack = String(game.black) === String(userId);
      if (!isWhite && !isBlack) return;

      const chess = new Chess(game.fen);
      const turn = chess.turn();
      if ((turn === "w" && !isWhite) || (turn === "b" && !isBlack)) return;

      const mv = chess.move({ from, to, promotion });
      if (!mv) {
        return socket.emit("invalidMove", { from, to, promotion });
      }

      game.fen = chess.fen();
      game.moves.push({ from, to, promotion: promotion || null });

      if (chess.isGameOver()) {
        if (chess.isCheckmate()) game.status = "checkmate";
        else if (chess.isStalemate()) game.status = "stalemate";
        else if (chess.isDraw()) game.status = "draw";
        else game.status = "ended";
      }
      await game.save();

      io.to(String(game._id)).emit("state", {
        fen: game.fen,
        lastMove: { from, to, promotion },
        status: game.status,
      });
    } catch (e) {
      console.error("move error", e.message);
    }
  });

  socket.on("resign", async ({ gameId }) => {
    const game = await Game.findById(gameId);
    if (!game || game.status !== "active") return;
    const isWhite = String(game.white) === String(userId);
    const isBlack = String(game.black) === String(userId);
    if (!isWhite && !isBlack) return;
    game.status = "resigned";
    await game.save();
    io.to(String(game._id)).emit("state", {
      fen: game.fen,
      status: game.status,
    });
  });

  socket.on("disconnect", () => {
    waitingQueue = waitingQueue.filter((q) => q.socketId !== socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);
