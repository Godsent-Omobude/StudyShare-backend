const sendPasswordResetEmail = async ({ to, resetUrl }) => {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  const senderName = process.env.BREVO_SENDER_NAME || "Study2Gate";

  if (!apiKey || !senderEmail) {
    if (process.env.NODE_ENV !== "production") {
      console.log(`[Password reset] Email not configured. Reset link for ${to}: ${resetUrl}`);
      return;
    }
    throw new Error("Password reset email service is not configured.");
  }

  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      sender: { email: senderEmail, name: senderName },
      to: [{ email: to }],
      subject: "Reset your Study2Gate password",
      htmlContent: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#0f172a">
          <h2>Reset your Study2Gate password</h2>
          <p>We received a request to reset your Study2Gate password.</p>
          <p>This link will expire in 30 minutes.</p>
          <p>
            <a href="${resetUrl}" style="display:inline-block;padding:12px 18px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">
              Reset Password
            </a>
          </p>
          <p>If you did not request this, you can safely ignore this email.</p>
          <p style="font-size:12px;color:#64748b">If the button does not work, copy this link into your browser:<br>${resetUrl}</p>
        </div>
      `,
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    console.error("Brevo error:", details);
    throw new Error("Unable to send password reset email.");
  }
};

export const sendVerificationEmail = async ({ to, code }) => {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  const senderName = process.env.BREVO_SENDER_NAME || "Study2Gate";

  if (!apiKey || !senderEmail) {
    if (process.env.NODE_ENV !== "production") {
      console.log(`[Email verification] Email not configured. Verification code for ${to}: ${code}`);
      return;
    }
    throw new Error("Verification email service is not configured.");
  }

  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      sender: { email: senderEmail, name: senderName },
      to: [{ email: to }],
      subject: "Verify your Study2Gate email address",
      htmlContent: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#0f172a">
          <h2>Verify your email address</h2>
          <p>Enter this code in Study2Gate to verify your email address:</p>
          <p style="font-size:32px;font-weight:800;letter-spacing:8px;margin:24px 0">${code}</p>
          <p>This code will expire in 15 minutes.</p>
          <p>If you did not create a Study2Gate account, you can safely ignore this email.</p>
        </div>
      `,
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    console.error("Brevo error:", details);
    throw new Error("Unable to send verification email.");
  }
};

// Generic templated email for copyright-moderation notifications (review,
// restriction, removal, restoration, information requests, warnings). Kept
// deliberately generic — the specific wording lives in copyrightNotify.js
// so every copyright email goes through one visual template.
export const sendCopyrightNotificationEmail = async ({ to, subject, heading, message }) => {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  const senderName = process.env.BREVO_SENDER_NAME || "Study2Gate";

  if (!apiKey || !senderEmail) {
    if (process.env.NODE_ENV !== "production") {
      console.log(`[Copyright email] Email not configured. ${subject} -> ${to}: ${message}`);
      return;
    }
    // Copyright emails are best-effort by design (see copyrightNotify.js) —
    // an unconfigured mail provider in production should not throw and
    // must never block the underlying moderation action.
    console.warn("Copyright notification email service is not configured.");
    return;
  }

  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      sender: { email: senderEmail, name: senderName },
      to: [{ email: to }],
      subject,
      htmlContent: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#0f172a">
          <h2>${heading}</h2>
          <p>${message}</p>
          <p style="font-size:12px;color:#64748b;margin-top:24px">
            This message relates to Study2Gate's copyright policy. It is an
            automated notice, not a legal determination of infringement.
          </p>
        </div>
      `,
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    console.error("Brevo error:", details);
    // Do not throw — see note above.
  }
};

export default sendPasswordResetEmail;
