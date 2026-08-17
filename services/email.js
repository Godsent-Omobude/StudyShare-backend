const sendPasswordResetEmail = async ({ to, resetUrl }) => {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (!apiKey || !from) {
    if (process.env.NODE_ENV !== "production") {
      console.log(`[Password reset] Email not configured. Reset link for ${to}: ${resetUrl}`);
      return;
    }
    throw new Error("Password reset email service is not configured.");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: "Reset your StudyShare password",
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#0f172a">
          <h2>Reset your StudyShare password</h2>
          <p>We received a request to reset your StudyShare password.</p>
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
    console.error("Resend error:", details);
    throw new Error("Unable to send password reset email.");
  }
};

export default sendPasswordResetEmail;
