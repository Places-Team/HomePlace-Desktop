use base64::{Engine as _, engine::general_purpose::STANDARD};
use keyring::{Entry, Error as KeyringError};
use p256::{
    SecretKey,
    elliptic_curve::rand_core::OsRng,
    pkcs8::{DecodePrivateKey, EncodePrivateKey, EncodePublicKey},
};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

const SERVICE: &str = "com.places-team.homeplace.desktop";
const MAX_PROFILES: usize = 12;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPairing {
    pub pairing_id: String,
    pub claim_secret: String,
    pub expires_at: String,
    pub address: String,
    pub server_name: String,
    pub device_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredProfile {
    pub server_id: String,
    pub server_name: String,
    pub address: String,
    pub device_id: String,
    pub device_name: String,
}

pub fn public_key(server_id: &str) -> Result<String, String> {
    let entry = entry("identity", server_id)?;
    let secret = match entry.get_secret() {
        Ok(bytes) => {
            let bytes = Zeroizing::new(bytes);
            SecretKey::from_pkcs8_der(&bytes)
                .map_err(|_| "The stored device identity is invalid.".to_string())?
        }
        Err(KeyringError::NoEntry) => {
            let secret = SecretKey::random(&mut OsRng);
            let document = secret
                .to_pkcs8_der()
                .map_err(|_| "Could not encode device identity.".to_string())?;
            entry
                .set_secret(document.as_bytes())
                .map_err(|_| secure_storage_error())?;
            secret
        }
        Err(_) => return Err(secure_storage_error()),
    };

    encode_public_key(&secret)
}

fn encode_public_key(secret: &SecretKey) -> Result<String, String> {
    let public_document = secret
        .public_key()
        .to_public_key_der()
        .map_err(|_| "Could not encode device public key.".to_string())?;
    Ok(STANDARD.encode(public_document.as_bytes()))
}

pub fn store_pending(server_id: &str, pending: &PendingPairing) -> Result<(), String> {
    let encoded = serde_json::to_string(pending)
        .map_err(|_| "Could not prepare pairing session.".to_string())?;
    entry("pending", server_id)?
        .set_password(&encoded)
        .map_err(|_| secure_storage_error())
}

pub fn load_pending(server_id: &str) -> Result<PendingPairing, String> {
    let encoded = entry("pending", server_id)?
        .get_password()
        .map_err(|error| match error {
            KeyringError::NoEntry => "No pending pairing session was found.".to_string(),
            _ => secure_storage_error(),
        })?;
    serde_json::from_str(&encoded).map_err(|_| "The stored pairing session is invalid.".to_string())
}

pub fn delete_pending(server_id: &str) -> Result<(), String> {
    delete_entry(entry("pending", server_id)?)
}

pub fn store_credential(server_id: &str, credential: &str) -> Result<(), String> {
    entry("credential", server_id)?
        .set_password(credential)
        .map_err(|_| secure_storage_error())
}

pub fn load_credential(server_id: &str) -> Result<Zeroizing<String>, String> {
    entry("credential", server_id)?
        .get_password()
        .map(Zeroizing::new)
        .map_err(|error| match error {
            KeyringError::NoEntry => "The HomePlace device credential is missing.".to_string(),
            _ => secure_storage_error(),
        })
}

pub fn clipboard_sync_enabled(server_id: &str) -> Result<bool, String> {
    match entry("clipboard-sync", server_id)?.get_password() {
        Ok(value) => Ok(value == "enabled"),
        Err(KeyringError::NoEntry) => Ok(false),
        Err(_) => Err(secure_storage_error()),
    }
}

pub fn store_clipboard_sync(server_id: &str, enabled: bool) -> Result<(), String> {
    let preference = entry("clipboard-sync", server_id)?;
    if enabled {
        preference
            .set_password("enabled")
            .map_err(|_| secure_storage_error())
    } else {
        delete_entry(preference)
    }
}

pub fn system_notifications_enabled(server_id: &str) -> Result<bool, String> {
    match entry("system-notifications", server_id)?.get_password() {
        Ok(value) => Ok(value != "disabled"),
        Err(KeyringError::NoEntry) => Ok(true),
        Err(_) => Err(secure_storage_error()),
    }
}

pub fn store_system_notifications(server_id: &str, enabled: bool) -> Result<(), String> {
    entry("system-notifications", server_id)?
        .set_password(if enabled { "enabled" } else { "disabled" })
        .map_err(|_| secure_storage_error())
}

pub fn store_profile(profile: &StoredProfile) -> Result<(), String> {
    let profiles = upsert_profile(load_profiles()?, profile.clone())?;
    store_profiles(&profiles)?;
    store_active_profile(profile)
}

pub fn load_profile() -> Result<Option<StoredProfile>, String> {
    let encoded = match active_profile_entry()?.get_password() {
        Ok(value) => value,
        Err(KeyringError::NoEntry) => return Ok(None),
        Err(_) => return Err(secure_storage_error()),
    };
    let profile: StoredProfile = serde_json::from_str(&encoded)
        .map_err(|_| "The stored HomePlace server profile is invalid.".to_string())?;
    Ok(Some(profile))
}

pub fn load_profiles() -> Result<Vec<StoredProfile>, String> {
    let encoded = match profiles_entry()?.get_password() {
        Ok(value) => value,
        Err(KeyringError::NoEntry) => return Ok(load_profile()?.into_iter().collect()),
        Err(_) => return Err(secure_storage_error()),
    };
    let profiles: Vec<StoredProfile> = serde_json::from_str(&encoded)
        .map_err(|_| "The stored HomePlace server list is invalid.".to_string())?;
    if profiles.len() > MAX_PROFILES {
        return Err("The stored HomePlace server list is too large.".into());
    }
    let mut server_ids = std::collections::HashSet::with_capacity(profiles.len());
    if profiles
        .iter()
        .any(|profile| !server_ids.insert(profile.server_id.as_str()))
    {
        return Err("The stored HomePlace server list contains duplicates.".into());
    }
    Ok(profiles)
}

pub fn activate_profile(server_id: &str) -> Result<StoredProfile, String> {
    let profile = load_profiles()?
        .into_iter()
        .find(|profile| profile.server_id == server_id)
        .ok_or_else(|| "The selected HomePlace server profile was not found.".to_string())?;
    store_active_profile(&profile)?;
    Ok(profile)
}

pub fn delete_profile(server_id: &str) -> Result<(), String> {
    let active = load_profile()?;
    let mut profiles = load_profiles()?;
    profiles.retain(|profile| profile.server_id != server_id);
    store_profiles(&profiles)?;

    if active
        .as_ref()
        .is_some_and(|profile| profile.server_id == server_id)
    {
        if let Some(next) = profiles.first() {
            store_active_profile(next)?;
        } else {
            delete_entry(active_profile_entry()?)?;
        }
    }

    let mut failed = false;
    for kind in [
        "pending",
        "credential",
        "identity",
        "clipboard-sync",
        "system-notifications",
    ] {
        if delete_entry(entry(kind, server_id)?).is_err() {
            failed = true;
        }
    }
    if failed {
        Err("Some HomePlace credentials could not be removed from secure storage.".into())
    } else {
        Ok(())
    }
}

fn store_profiles(profiles: &[StoredProfile]) -> Result<(), String> {
    let encoded = serde_json::to_string(profiles)
        .map_err(|_| "Could not prepare HomePlace server list.".to_string())?;
    profiles_entry()?
        .set_password(&encoded)
        .map_err(|_| secure_storage_error())
}

fn upsert_profile(
    mut profiles: Vec<StoredProfile>,
    profile: StoredProfile,
) -> Result<Vec<StoredProfile>, String> {
    profiles.retain(|stored| stored.server_id != profile.server_id);
    if profiles.len() >= MAX_PROFILES {
        return Err(format!(
            "HomePlace Desktop supports up to {MAX_PROFILES} paired servers."
        ));
    }
    profiles.push(profile);
    Ok(profiles)
}

fn store_active_profile(profile: &StoredProfile) -> Result<(), String> {
    let encoded = serde_json::to_string(profile)
        .map_err(|_| "Could not prepare HomePlace server profile.".to_string())?;
    active_profile_entry()?
        .set_password(&encoded)
        .map_err(|_| secure_storage_error())
}

fn entry(kind: &str, server_id: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, &format!("{kind}:{server_id}"))
        .map_err(|_| "Could not open platform secure storage.".to_string())
}

fn active_profile_entry() -> Result<Entry, String> {
    Entry::new(SERVICE, "active-profile")
        .map_err(|_| "Could not open platform secure storage.".to_string())
}

fn profiles_entry() -> Result<Entry, String> {
    Entry::new(SERVICE, "profiles")
        .map_err(|_| "Could not open platform secure storage.".to_string())
}

fn delete_entry(entry: Entry) -> Result<(), String> {
    match entry.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(_) => Err(secure_storage_error()),
    }
}

fn secure_storage_error() -> String {
    "Could not access platform secure storage. Unlock it and try again.".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::pkcs8::DecodePublicKey;

    #[test]
    fn exports_a_canonical_p256_spki_public_key() {
        let secret = SecretKey::random(&mut OsRng);
        let encoded = encode_public_key(&secret).unwrap();
        let document = STANDARD.decode(encoded).unwrap();

        assert_eq!(document.len(), 91);
        assert!(p256::PublicKey::from_public_key_der(&document).is_ok());
    }

    fn profile(index: usize) -> StoredProfile {
        StoredProfile {
            server_id: format!("server-{index}"),
            server_name: format!("Home {index}"),
            address: format!("https://home-{index}.example"),
            device_id: format!("device-{index}"),
            device_name: "Desktop".into(),
        }
    }

    #[test]
    fn replaces_existing_profile_without_reordering_other_servers() {
        let profiles = vec![profile(1), profile(2)];
        let mut replacement = profile(1);
        replacement.server_name = "Updated Home".into();

        let profiles = upsert_profile(profiles, replacement.clone()).unwrap();

        assert_eq!(profiles.len(), 2);
        assert_eq!(profiles[0], profile(2));
        assert_eq!(profiles[1], replacement);
    }

    #[test]
    fn enforces_the_paired_server_limit() {
        let profiles = (0..MAX_PROFILES).map(profile).collect();

        let error = upsert_profile(profiles, profile(MAX_PROFILES + 1)).unwrap_err();

        assert!(error.contains("up to 12"));
    }
}
