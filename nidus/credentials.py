"""OS credentials; secrets never travel through a subprocess or persistent file."""
import ctypes
import os
import re
import sys
from typing import Protocol
from .gateway import ModelError


class CredentialStore(Protocol):
    def put(self, ref, secret): ...
    def get(self, ref): ...
    def replace(self, ref, secret): ...
    def delete(self, ref): ...
    def exists(self, ref): ...


def validate_secret(secret):
    if not isinstance(secret, str) or len(secret) > 8192 or any(ord(c) < 32 or ord(c) > 126 for c in secret):
        raise ModelError('invalid_credential')


class EnvironmentCredentialProvider:
    """Read-only compatibility provider; never writes an env file."""
    def get(self, ref):
        if not re.fullmatch(r'env:[A-Z][A-Z0-9_]*(?:_API_KEY|_TOKEN)', ref):
            raise ModelError('invalid_credential_reference')
        value = os.environ.get(ref[4:])
        if value is None:
            raise ModelError('credential_missing')
        validate_secret(value)
        return value

    def exists(self, ref):
        try:
            self.get(ref)
            return True
        except ModelError:
            return False


class MacOSKeychainCredentialStore:
    """Security.framework generic password API, no shell/argv/diagnostic secret."""
    service = b'org.nidus.provider-connections.v1'

    def __init__(self):
        if sys.platform != 'darwin':
            raise ModelError('credential_backend_unsupported')
        self.lib = ctypes.CDLL('/System/Library/Frameworks/Security.framework/Security')
        self.cf = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
        ptr = ctypes.c_void_p; uint = ctypes.c_uint32
        signatures = {
            'SecKeychainFindGenericPassword': [ptr,uint,ptr,uint,ptr,ctypes.POINTER(uint),ctypes.POINTER(ptr),ctypes.POINTER(ptr)],
            'SecKeychainAddGenericPassword': [ptr,uint,ptr,uint,ptr,uint,ptr,ctypes.POINTER(ptr)],
            'SecKeychainItemModifyAttributesAndData': [ptr,ptr,uint,ptr],
            'SecKeychainItemDelete': [ptr], 'SecKeychainItemFreeContent': [ptr,ptr]}
        for name, args in signatures.items():
            fn = getattr(self.lib, name); fn.argtypes=args; fn.restype=ctypes.c_int32
        self.cf.CFRelease.argtypes=[ptr]; self.cf.CFRelease.restype=None

    def _ref(self, ref):
        if not isinstance(ref, str) or not re.fullmatch(r'cred_[0-9a-f]{32}', ref):
            raise ModelError('invalid_credential_reference')
        return ref.encode()

    def _check(self, status):
        if status:
            raise ModelError('credential_missing' if status == -25300 else 'credential_store_failure')

    def _find(self, ref, read=False):
        account=self._ref(ref); length=ctypes.c_uint32(); data=ctypes.c_void_p(); item=ctypes.c_void_p()
        status=self.lib.SecKeychainFindGenericPassword(None,len(self.service),self.service,len(account),account,
            ctypes.byref(length) if read else None,ctypes.byref(data) if read else None,ctypes.byref(item))
        self._check(status)
        return length, data, item

    def put(self, ref, secret):
        validate_secret(secret); account=self._ref(ref); raw=secret.encode()
        self._check(self.lib.SecKeychainAddGenericPassword(None,len(self.service),self.service,len(account),account,len(raw),raw,None))

    def get(self, ref):
        length,data,item=self._find(ref,True)
        try:
            return ctypes.string_at(data,length.value).decode()
        finally:
            self.lib.SecKeychainItemFreeContent(None,data); self.cf.CFRelease(item)

    def replace(self, ref, secret):
        validate_secret(secret); _,_,item=self._find(ref); raw=secret.encode()
        try:
            self._check(self.lib.SecKeychainItemModifyAttributesAndData(item,None,len(raw),raw))
        finally:
            self.cf.CFRelease(item)

    def delete(self, ref):
        try:
            _,_,item=self._find(ref)
        except ModelError as error:
            if error.code == 'credential_missing': return
            raise
        try:
            self._check(self.lib.SecKeychainItemDelete(item))
        finally:
            self.cf.CFRelease(item)

    def exists(self, ref):
        try:
            _,_,item=self._find(ref); self.cf.CFRelease(item); return True
        except ModelError as error:
            if error.code == 'credential_missing': return False
            raise
