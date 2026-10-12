"""Exercise the macOS Keychain with a disposable synthetic credential."""
import json
import uuid
from nidus.credentials import MacOSKeychainCredentialStore
from nidus.gateway import ModelError, utc_now


def main():
    store=MacOSKeychainCredentialStore(); ref='cred_'+uuid.uuid4().hex
    secret=uuid.uuid4().hex; owned=False
    result={'timestamp':utc_now(),'backend':'macOS Security.framework','synthetic_secret_only':True}
    try:
        assert not store.exists(ref)
        store.put(ref,secret); owned=True
        assert store.exists(ref); assert store.get(ref)==secret
        store.replace(ref,secret+'-replacement'); assert store.get(ref)==secret+'-replacement'
        store.delete(ref); owned=False
        assert not store.exists(ref)
        try: store.get(ref)
        except ModelError as error: assert error.code=='credential_missing'
        else: raise AssertionError()
        result['status']='PASS'
    except ModelError as error:
        result.update(status='FAILED',error=error.code)
    finally:
        if owned: store.delete(ref)
    print(json.dumps(result))
    return 0 if result['status']=='PASS' else 1


if __name__=='__main__': raise SystemExit(main())
