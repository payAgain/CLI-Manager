#[cfg(target_os = "windows")]
pub(crate) fn entry(account: &str) -> Result<keyring_core::Entry, String> {
    use std::sync::OnceLock;

    static STORE_INIT: OnceLock<Result<(), String>> = OnceLock::new();
    STORE_INIT
        .get_or_init(|| {
            let store = windows_native_keyring_store::Store::new()
                .map_err(|err| format!("initialize Windows credential store failed: {err}"))?;
            keyring_core::set_default_store(store);
            Ok(())
        })
        .clone()?;

    keyring_core::Entry::new("CLI-Manager", account)
        .map_err(|err| format!("create credential entry failed: {err}"))
}
