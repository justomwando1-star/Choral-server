export const REGISTRATION_TYPES = {
  ENROLLMENT: "enrollment",
  COMPOSER_REQUEST: "composer_request",
};

export const DEFAULT_REGULATIONS = {
  enrollment_fee: 0,
  composer_request_fee: 0,
  bank_name: "I&M Bank",
  bank_account_number: "0030 7335 5161 50",
  account_name: "Murekefu Music Hub",
  controlling_admin_identifier: "fredrickmakori102",
  is_active: true,
};

function normalizeIdentifier(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function isRegulationsControllerUser(user, configuredIdentifier) {
  const expected = normalizeIdentifier(
    configuredIdentifier || DEFAULT_REGULATIONS.controlling_admin_identifier,
  );
  if (!expected) return false;

  const email = String(user?.email || "")
    .trim()
    .toLowerCase();
  const emailLocalPart = email.includes("@") ? email.split("@")[0] : email;
  const displayName = String(user?.display_name || "")
    .trim()
    .toLowerCase();

  const candidates = [
    normalizeIdentifier(email),
    normalizeIdentifier(emailLocalPart),
    normalizeIdentifier(displayName),
    normalizeIdentifier(user?.id),
    normalizeIdentifier(user?.auth_uid),
  ].filter(Boolean);

  return candidates.includes(expected);
}

export function isMissingRegistrationPaymentsError(err) {
  const code = String(err?.code || "").toUpperCase();
  const message = String(err?.message || "").toLowerCase();
  return (
    code === "42P01" ||
    code === "PGRST204" ||
    code === "PGRST205" ||
    message.includes("registration_payment_submissions")
  );
}

export function isMissingRegistrationRegulationsError(err) {
  const code = String(err?.code || "").toUpperCase();
  const message = String(err?.message || "").toLowerCase();
  return (
    code === "42P01" ||
    code === "PGRST204" ||
    code === "PGRST205" ||
    message.includes("registration_regulations")
  );
}

export function isMissingRegistrationTablesError(err) {
  return (
    isMissingRegistrationPaymentsError(err) ||
    isMissingRegistrationRegulationsError(err)
  );
}

export function missingRegistrationTablesResponse(res) {
  return res.status(500).json({
    message:
      "Registration payment tables are missing. Run migration 022_create_registration_payment_controls.sql and retry.",
  });
}

export async function ensureActiveRegistrationRegulations(supabaseClient) {
  const { data: activeRow, error: activeErr } = await supabaseClient
    .from("registration_regulations")
    .select("*")
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (activeErr) throw activeErr;
  if (activeRow) return { ...DEFAULT_REGULATIONS, ...activeRow };

  const insertPayload = {
    ...DEFAULT_REGULATIONS,
  };
  const { data: created, error: createErr } = await supabaseClient
    .from("registration_regulations")
    .insert(insertPayload)
    .select("*")
    .maybeSingle();
  if (createErr) throw createErr;
  if (created) return { ...DEFAULT_REGULATIONS, ...created };

  return { ...DEFAULT_REGULATIONS };
}

export function getRequiredRegistrationFee(regulations, registrationType) {
  if (registrationType === REGISTRATION_TYPES.ENROLLMENT) {
    return Number(regulations?.enrollment_fee || 0);
  }
  if (registrationType === REGISTRATION_TYPES.COMPOSER_REQUEST) {
    return Number(regulations?.composer_request_fee || 0);
  }
  return 0;
}

export async function findApprovedUnconsumedRegistrationPayment(
  supabaseClient,
  requesterId,
  registrationType,
) {
  const { data, error } = await supabaseClient
    .from("registration_payment_submissions")
    .select("*")
    .eq("requester_id", requesterId)
    .eq("registration_type", registrationType)
    .eq("status", "approved")
    .eq("is_consumed", false)
    .order("reviewed_at", { ascending: false })
    .order("submitted_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function consumeRegistrationPaymentSubmission(
  supabaseClient,
  submissionId,
  consumedFor,
  consumedTargetId,
) {
  if (!submissionId) return null;

  const { data, error } = await supabaseClient
    .from("registration_payment_submissions")
    .update({
      is_consumed: true,
      consumed_for: consumedFor || null,
      consumed_target_id: consumedTargetId || null,
      consumed_at: new Date().toISOString(),
    })
    .eq("id", submissionId)
    .eq("is_consumed", false)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data || null;
}
