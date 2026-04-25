import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

import type { JwtPayload } from "./types.js";

function getJwtSecret() {
  return process.env.JWT_SECRET ?? "socket-flow-dev-secret";
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export function signToken(payload: JwtPayload) {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: "30d" });
}

export function verifyToken(token: string) {
  return jwt.verify(token, getJwtSecret()) as JwtPayload;
}
