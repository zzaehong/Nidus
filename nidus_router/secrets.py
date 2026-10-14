"""Provider credentials live only in a supported OS credential store."""
import hashlib
import secrets

from .errors import RouterError


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def new_token():
    return secrets.token_urlsafe(32)


class OSSecrets:
    def __init__(self, namespace):
        self.service = "nidus-router:" + digest(str(namespace))[:20]

    def backend(self):
        import keyring
        # Do not silently fall back to plaintext files or third-party backends.
        from keyring.backends.chainer import ChainerBackend
        backend = keyring.get_keyring()
        if isinstance(backend, ChainerBackend):
            backend = next((b for b in backend.backends if self.trusted(b)), None)
        if not self.trusted(backend):
            raise RouterError("credential_unavailable", 503)
        return backend

    @staticmethod
    def trusted(backend):
        return backend is not None and type(backend).__module__ in {
            "keyring.backends.macOS", "keyring.backends.Windows", "keyring.backends.SecretService"}

    def get(self, reference):
        try:
            value = self.backend().get_password(self.service, reference)
            if not value:
                raise ValueError()
            return value
        except Exception:
            raise RouterError("credential_unavailable", 503, True) from None

    def set(self, reference, value):
        try:
            self.backend().set_password(self.service, reference, value)
        except Exception:
            raise RouterError("credential_unavailable", 503) from None

    def delete(self, reference):
        try:
            backend = self.backend()
            if backend.get_password(self.service, reference) is not None:
                backend.delete_password(self.service, reference)
        except Exception:
            raise RouterError("credential_unavailable", 503) from None
