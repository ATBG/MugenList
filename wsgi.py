import os
import sys

# Ensure scripts folder is in path so internal imports resolve correctly
SCRIPT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'scripts')
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

from backend import app

if __name__ == '__main__':
    # Fallback to waitress or standard flask if executed directly
    port = int(os.environ.get('PORT', os.environ.get('MUGELLIST_PORT', 8000)))
    try:
        from waitress import serve
        print(f"Starting Waitress production server on port {port}...")
        serve(app, host='0.0.0.0', port=port)
    except ImportError:
        print(f"Waitress not installed. Starting Flask built-in server on port {port}...")
        app.run(host='0.0.0.0', port=port, threaded=True)
