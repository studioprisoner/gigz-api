/**
 * Resend email client wrapper for OTP emails
 */

import { Resend } from "resend";

const resend = process.env.RESEND_API_KEY
	? new Resend(process.env.RESEND_API_KEY)
	: null;

/**
 * Send OTP verification email
 */
export async function sendOTPEmail(to: string, code: string): Promise<void> {
	if (!resend) {
		console.warn(
			"[OTP] RESEND_API_KEY not configured, skipping email send. Code:",
			code,
		);
		return;
	}

	const from = process.env.EMAIL_FROM || "Gigz <noreply@gigz.app>";

	const { error } = await resend.emails.send({
		from,
		to,
		subject: "Your Gigz verification code",
		html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px; max-width: 600px; margin: 0 auto;">
  <h1 style="color: #333; font-size: 24px; margin-bottom: 20px;">Your verification code</h1>
  <div style="background: #f5f5f5; border-radius: 8px; padding: 24px; text-align: center; margin-bottom: 20px;">
    <span style="font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #111;">${code}</span>
  </div>
  <p style="color: #666; font-size: 14px; line-height: 1.5;">
    Enter this code to sign in to Gigz. This code will expire in 10 minutes.
  </p>
  <p style="color: #999; font-size: 12px; margin-top: 30px;">
    If you didn't request this code, you can safely ignore this email.
  </p>
</body>
</html>
`,
		text: `Your Gigz verification code is: ${code}\n\nThis code will expire in 10 minutes.\n\nIf you didn't request this code, you can safely ignore this email.`,
	});

	if (error) {
		console.error("[OTP] Failed to send email:", error);
		throw new Error(`Failed to send verification email: ${error.message}`);
	}

	console.log(`[OTP] Verification email sent to ${to}`);
}
