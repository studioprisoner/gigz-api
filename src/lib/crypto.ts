/**
 * Cryptographic utilities for OTP authentication
 */

import { createHash, randomInt } from "node:crypto";

/**
 * Hash a value using SHA-256
 * Used for storing email addresses and OTP codes securely
 */
export function hashSHA256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/**
 * Generate a 6-digit OTP code
 * Uses crypto.randomInt for cryptographically secure random numbers
 */
export function generateOTPCode(): string {
	return randomInt(0, 1000000).toString().padStart(6, "0");
}

/**
 * Normalize email for consistent hashing
 * Converts to lowercase and trims whitespace
 */
export function normalizeEmail(email: string): string {
	return email.toLowerCase().trim();
}
