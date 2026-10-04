import os
import os.path

from os import path
from scapy.all import Ether

class Hardware():

    # Serial Checker(should be custom class)

    def get_serial_impl(self, command):
        output = ""
        try:
            stream = os.popen(command)
            output = stream.read()
        except Exception as e:
            print("get_serial_impl exception", e)
        return output

    def get_serial(self):

        """Executes predefined shell commands to fetch CPU serial on each supported platform."""

        # Current solution
        mac = Ether().src
        if mac: 
            return mac

        # Legacy, get serial on OS X
        if path.exists('/usr/sbin/ioreg'):
            command = "ioreg -l | grep IOPlatformSerialNumber | tr -d '\"|\t\n\r' | tr -d '       IOPlatformSerialNumber = '"
            output = "osx:" + self.get_serial_impl(command)
            print("[debug:ioreg] # ", output)

        # Legacy, get serial on Linux
        elif path.exists('/proc/cpuinfo'):
            command = "cat /proc/cpuinfo | grep Serial | tr -d 'Serial\t :'"
            output = "rpi:" + self.get_serial_impl(command)
            print("[debug:cpuinfo] # ", output)
            
        return output