export function serverError(res, err) {
  console.error(err);
  return res.status(500).json({
    message: err?.message || "Internal server error",
  });
}

export default { serverError };
