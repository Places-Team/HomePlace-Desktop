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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPairing {
    pub pairing_id: String,
    pub claim_secret: String,
    pub expires_at: String,
    pub address: String,
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
                .map_err(|_| "Could not encode the device identity.".to_string())?;
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
        .map_err(|_| "Could not encode the device public key.".to_string())?;
    Ok(STANDARD.encode(public_document.as_bytes()))
}

pub fn store_pending(server_id: &str, pending: &PendingPairing) -> Result<(), String> {
    let encoded = serde_json::to_string(pending)
        .map_err(|_| "Could not prepare the pairing session.".to_string())?;
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
    match entry("pending", server_id)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(_) => Err(secure_storage_error()),
    }
}

pub fn store_credential(server_id: &str, credential: &str) -> Result<(), String> {
    entry("credential", server_id)?
        .set_password(credential)
        .map_err(|_| secure_storage_error())
}

fn entry(kind: &str, server_id: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, &format!("{kind}:{server_id}"))
        .map_err(|_| "Could not open platform secure storage.".to_string())
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
}
