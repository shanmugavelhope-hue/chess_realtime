import mongoose from 'mongoose';

const moveSchema = new mongoose.Schema({
  from: String,
  to: String,
  promotion: { type: String, default: null }
}, { _id: false });

const gameSchema = new mongoose.Schema({
  white: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  black: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  fen:   { type: String, required: true },
  moves: [moveSchema],
  status: { type: String, enum: ['active','checkmate','stalemate','draw','resigned','ended'], default: 'active' }
}, { timestamps: true });

export default mongoose.model('Game', gameSchema);
