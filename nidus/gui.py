"""Compatibility imports for the former GUI server, now API only."""
from .api import APIServer, Handler, serve

# Keep import compatibility for integrations that used the old class name.
GUIServer = APIServer
