// Central password strength policy used by registration, password change,
// and password reset. Keep this in sync with the frontend checklist in
// frontend/src/utils/passwordRequirements.js.

export const PASSWORD_MIN_LENGTH = 12;

const RULES = [
  {
    id: "length",
    message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`,
    test: (value) => value.length >= PASSWORD_MIN_LENGTH,
  },
  {
    id: "uppercase",
    message: "Password must contain at least 1 uppercase letter (A-Z).",
    test: (value) => /[A-Z]/.test(value),
  },
  {
    id: "lowercase",
    message: "Password must contain at least 1 lowercase letter (a-z).",
    test: (value) => /[a-z]/.test(value),
  },
  {
    id: "number",
    message: "Password must contain at least 1 number (0-9).",
    test: (value) => /[0-9]/.test(value),
  },
  {
    id: "special",
    message: "Password must contain at least 1 special character.",
    test: (value) => /[^A-Za-z0-9]/.test(value),
  },
];

// Returns { valid: boolean, message: string|null } — message is the first
// unmet requirement, suitable for returning directly to the client.
export const validatePassword = (password) => {
  const value = typeof password === "string" ? password : "";

  for (const rule of RULES) {
    if (!rule.test(value)) {
      return { valid: false, message: rule.message };
    }
  }

  return { valid: true, message: null };
};

export default validatePassword;
