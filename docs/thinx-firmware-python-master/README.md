# THiNXLib for Python

This is example/test/development project for THiNX client library written in Python (mainly for Linux-based embedded devices, however works on OSX and other systems as well).
## Installation

    pip3 install -r requirements.txt
## Running

    export DISPLAY=:0.0 && python3 ./app.py
    

* Test application will connect to backend and display incoming MQTT messages in form of alert.

* Upon pushing the `Publish Test` button, app sends message to backend.

## TODO

* Environment Variable Support
* OTA Update Support

## Compatibility

Developed on Mac OS.

Tested on Raspberry Pi 3 model B.
