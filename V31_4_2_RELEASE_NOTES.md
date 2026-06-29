# v31.4.2 — Pilot Polish

- Centered the cute footer cleanly across user/admin/auth pages.
- Made Regenerate Summary visible only for `super_admin` users.
- Hardened the summary route so non-admin users cannot force regeneration with `?regenerate=1`.
- Changed What Did I Discuss quick ranges so Last 3d/7d/15d/30d only fill the range and wait for the user to click Find discussions.
