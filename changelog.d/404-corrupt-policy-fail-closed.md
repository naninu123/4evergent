Issue #404: corrupt persisted policy JSON now fails closed instead of silently
falling back to permissive default rules; the API reports policy unavailability
so operators can repair the stored configuration.
