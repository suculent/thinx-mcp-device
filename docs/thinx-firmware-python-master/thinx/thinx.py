#!/usr/bin/python
# -*- coding: utf-8 -*-

import requests
import os
import json

from scapy.all import Ether

import paho.mqtt.client as mqtt

CONTENT_TYPE = 'application/json'


class THiNX():

    def set_attr(self, key, value):
        try:
            if value!=None:
                self.config[key] = value
                # print("Setting ", key, ":", value)
        except Exception:
            pass

    def __init__(self):

        self.DEBUG_MODE = True  # print logs

        self.TIMEOUT = 180

        self.mqtt_client = None
        self.mqtt_connected = False
        self.AVAILABLE_UPDATE_URL = None

        self.thx_reboot_response = '{ "status" : "rebooting" }'
        self.thx_update_question = '{ title: "Update Available", body: "There is an update available for this device. Do you want to install it now?", type: "actionable", response_type: "bool" }"'
        self.thx_update_success = '{ title: "Update Successful", body: "The device has been successfully updated.", type: "success" }'

        # CONNECTION
        self.KEEPALIVE = 120
        self.CLEANSESSION = False  # set false to keep retained messages
        self.MQTT_LWT_QOS = 0
        self.MQTT_LWT_RETAIN = 1
        self.MQTT_QOS = 0
        self.MQTT_RETAIN = 1
        self.MQTT_DEVICE_QOS = 2

        #CONFIG_PATH = self.file_path('../thinx.json')
        CONFIG_PATH = os.getcwd() + '/thinx.json'
        CONFIG_PATH = 'thinx.json'

        # Called upon registration
        self.registration_callback = None

        # Called upon each new message
        self.mqtt_callback = None

        try:
            fp = open(CONFIG_PATH, 'r')
            settings = json.load(fp)
        except Exception as ex:
            self.error("JSON configuration did not load from " + CONFIG_PATH + " at " + os.getcwd())
            raise Exception("Faled to open") from ex

        #print(json.dumps(settings, indent = 4, sort_keys=True))

        self.config = {
            'THINX_ALIAS' : "python-test"
        }

        config_keys = [ 
            'THINX_COMMIT_ID',
            'THINX_FIRMWARE_VERSION_SHORT',
            'THINX_FIRMWARE_VERSION', 
            'THINX_UDID',
            'THINX_CLOUD_URL',
            'THINX_MQTT_URL',
            'THINX_API_KEY',
            'THINX_OWNER',
            'THINX_ALIAS',
            'THINX_APP_VERSION',
            'THINX_DEVICE_ALIAS',
            'THINX_AUTO_UPDATE',
            'THINX_MQTT_PORT',
            'THINX_API_PORT',
            'THINX_ENV_SSID',
            'THINX_ENV_PASS', 
            'THINX_ENV' ]

        for key in config_keys:
            value = settings.get(key)
            self.set_attr(key, value)

        if not hasattr(self, 'THINX_ENV_SSID') or not hasattr(self, 'THINX_ENV_PASS'):
            # self.info("THINX_ENV_SSID and THINX_ENV_PASS not set.")
            pass

        self.start()

    def dlog(self, astring):
        # if self.DEBUG==True: # causes recursion loop, should be non-class method
        print("[THiNX]: ", astring)

    def info(self, astring):
        # if self.DEBUG==True: # causes recursion loop, should be non-class method
        print("THiNX [info]: " + astring)

    def warning(self, astring):
        # if self.DEBUG==True: # causes recursion loop, should be non-class method
        print("THiNX [warning]: " + astring)

    def error(self, astring):
        # if self.DEBUG==True: # causes recursion loop, should be non-class method
        print("THiNX [debug]: " + astring)

    def registration_json_body(self):
        BODY = {
            "mac": self.thinx_device_mac(),
            "firmware": self.config['THINX_FIRMWARE_VERSION'],
            "commit": self.config['THINX_COMMIT_ID'],
            "version": self.config['THINX_FIRMWARE_VERSION_SHORT'],
            "alias": self.config['THINX_ALIAS'],
            "udid": self.config['THINX_UDID'],
            "owner": self.config['THINX_OWNER'],
            "platform" : "python"
        }
        return json.dumps( { "registration": BODY } )

    def thinx_device_mac(self):
        return Ether().src

    def mqtt_device_channel(self):
        dc = "/" + self.config['THINX_OWNER'] + "/" + self.config['THINX_UDID']
        return dc

    def mqtt_status_channel(self):
        sc = self.mqtt_device_channel() + "/status"
        return sc

    def base_url(self):
        # TODO: if port defined, use also custom port
        return self.config.get('THINX_CLOUD_URL')

    def thinx_register(self):
        url = self.base_url() + '/device/register'

        headers = {
            'Authentication': self.config.get('THINX_API_KEY'),
            'Accept': CONTENT_TYPE,
            'Origin': 'device',
            'Content-Type': CONTENT_TYPE,
            'User-Agent': 'THiNX-Client'
        }
        
        # should be provided by registration_json_body()
        registration_request = {
            'registration': {
                'mac': self.thinx_device_mac(), 
                'firmware': self.config.get('THINX_FIRMWARE_VERSION'),
                'version': self.config.get('THINX_FIRMWARE_VERSION_SHORT'),
                'alias': self.config.get('THINX_DEVICE_ALIAS'),
                'owner': self.config.get('THINX_OWNER'),
                'udid': self.config.get('THINX_UDID')
            }
        }

        data = json.dumps(registration_request)
        r = requests.post(url, data=data, headers=headers)

        if r.status_code == requests.codes.ok:
            try:
                j = r.json()
            except Exception:
                self.error("JSON Parser Exception: " + r.text)
                j = r.text
        else:
            self.error("Response status code not OK: " + r.text)

        self.parse(j)
        r.close()

    def thinx_update(self, data):
        url = self.base_url() + '/device/firmware'
        headers = {
            'Accept': '*/*',
            'Authentication': self.config.get('THINX_API_KEY'),
            'Content-Type': CONTENT_TYPE, 
            'Origin': 'device',
            'User-Agent': 'THiNX-Client'
        }
        update_request = {
            'alias': data.alias,
            'commit': data.commit,
            'hash': data.hash,
            'owner': data.owner,
            'udid': self.config.get('THINX_UDID'),
            'update': {
                'mac': self.thinx_device_mac(),
            }
        }

        data = json.dumps(update_request)
        resp = requests.post(url, data=data, headers=headers)
        if resp.status_code == requests.codes.ok:
            self.update_and_reboot(resp)
        else:
            self.error("No update response.")

        resp.close()

    def parse(self, response):
        try:
            success = response['registration']['success']
            if success == False:
                self.error("Failure.")
                return
        except Exception:
            self.warning("No primary success key found in registration response")
            #print(response)
            return

        self.parse_update(response)
        self.parse_registration(response)
        self.parse_notification(response)

        if self.config.get('THINX_UDID') == "":
            self.warning("MQTT cannot be used until UDID will be assigned.")
        else:
            self.thinx_mqtt()

    def get_device_info(self):
        
        json_object = { 
                        'alias': self.config.get('THINX_DEVICE_ALIAS'),
                        'owner': self.config.get('THINX_OWNER'),
                        'apikey': self.config.get('THINX_API_KEY'),
                        'udid': self.config.get('THINX_UDID'),
                        'AVAILABLE_UPDATE_URL': self.AVAILABLE_UPDATE_URL,
                        'platform': 'python'
                        }

        return json.dumps(json_object, indent = 4, sort_keys=True)

    def apply_device_info(self, info):
        # ugly, change config to object class that can import JSON
        self.config['THINX_DEVICE_ALIAS']   = info['alias']
        self.config['THINX_OWNER']          = info['owner']
        self.config['THINX_API_KEY']        = info['apikey']
        self.config['THINX_UDID']           = info['udid']
        self.config['AVAILABLE_UPDATE_URL'] = info['AVAILABLE_UPDATE_URL']

    def save_device_info(self):
        info = self.get_device_info()
        self.info("Saving device info (todo: encrypt): " + info)
        CONFIG_PATH = self.file_path('thinx.cfg')
        try:
            f = open(CONFIG_PATH, 'w')
            f.write(info)
            f.close()
        except Exception:
            self.warning("Saving device info failed!")

    def file_path(self, relative_path):
        dir = os.path.dirname(os.path.abspath(__file__))
        split_path = relative_path.split("/")
        new_path = os.path.join(dir, *split_path)
        return new_path

    def restore_device_info(self):
        CONFIG_PATH = self.file_path('thinx.cfg')
        try:
            f = open(CONFIG_PATH, 'r')
            info = f.read('\n')
            f.close()
            self.apply_device_info(json.loads(info))
        except Exception:
            self.info("No device info to be restored. (Before first registration.)")

    def publish(self, message):
        if self.mqtt_connected == False:
            self.info("Not connected to MQTT, cannot publish...")
        else:
            self.mqtt_publish(self.mqtt_status_channel(), message)

    def mqtt_publish(self, channel, message):
        print("Publishing", channel, message)
        if self.mqtt_client != None:
            self.mqtt_client.publish(channel, message)
        else:
            self.warning("No MQTT client ready for publish...")

    def thinx_mqtt_timeout(self):
        self.mqtt_connected = False

    def on_connect(self, client, userdata, flags, rc):

        if rc > 0:
            print("[DEBUG] MQTT on_connect: ", flags, rc)
            if rc == 5:
                raise Exception("MQTT not authorized")
            return

        if (rc != 0):
            return

        self.mqtt_connected = True
        
        try:
            dc = self.mqtt_device_channel()
            self.info("Subscribing device channel " + dc)
            self.mqtt_client.subscribe(dc)
        except Exception as ex:
            raise Exception("MQTT") from ex

        try:
            sc = self.mqtt_status_channel()
            self.info("Subscribing status channel " + sc)
            self.mqtt_client.subscribe(sc)

            status = '{ "status" : "connected" }'
            self.info("Publishing first status to channel " + sc)
            self.mqtt_client.publish(
                self.mqtt_status_channel(),
                status
            )
            
        except Exception as ex:
            raise Exception("MQTT") from ex

        

    def thinx_mqtt(self):
        
        self.restore_device_info()
        
        if not self.config.get('THINX_API_KEY'):
            self.warning("THINX: API Key Missing...")
            return

        if not self.config.get('THINX_UDID') or self.config.get('THINX_UDID')=="0":
            self.warning("THINX: UDID Missing, thinx_mqtt() should be called only upon successful registration...")
            return
        
        self.info("Initializing message queue...")

        clientid = self.thinx_device_mac()
        clean_session = False

        self.mqtt_client = mqtt.Client(clientid, clean_session)

        username = self.config['THINX_UDID']
        password = self.config['THINX_API_KEY']
        host = self.config['THINX_MQTT_URL']
        port = self.config['THINX_MQTT_PORT']
        keepalive = 60

        #self.mqtt_client.on_publish =
        #self.mqtt_client.on_subscribe =

        self.mqtt_client.on_message = self.thinx_mqtt_callback
        self.mqtt_client.on_connect = self.on_connect

        lwt = '{ "status" : "disconnected" }'

        self.mqtt_client.will_set(
            self.mqtt_status_channel(), 
            lwt,
            retain=False,
            qos=0
        )

        self.info("Using MQTT username " + username + " with password " + password) 

        self.mqtt_client.username_pw_set(username, password)

        try:
            self.mqtt_client.connect(host, port, keepalive)
            self.info("Connecting to MQTT host " + host + " port " + str(port))
            self.mqtt_client.loop_start()
        except Exception as err:
            self.warning(err)

    def thinx_mqtt_callback(self, client, userdata, msg):
        # Drop own messages first to prevent loops
        if msg != None:
            if msg.topic == self.mqtt_status_channel():
                return;
        self.process_mqtt(msg.payload.decode("utf-8"))
        self.info("Message on topic: " + msg.topic)
        #self.info(msg.payload.decode("utf-8"))
        if self.mqtt_callback != None:
            self.mqtt_callback(msg)

    def process_mqtt(self, response):
        self.info("Incoming MQTT response:" + response)
        try:
            data = json.loads(response)
            try:
                upd = data['update']
                if upd:
                    self.update_and_reboot(upd)
            except Exception:
                pass
            try:
                msg = data['message']
                if msg:
                    self.parse(data)
            except Exception:
                pass
        except Exception:
            self.info("THINX: Payload is not JSON, passing by: " + response)

    def parse_notification(self, response):
        try:
            no = response['registration']['notification']
        except Exception:
            #self.info("No registration notification key found.")
            return False

        #self.info("[parse_notification] Parsing registration response:")
        #self.info(response)

        try:
            rtype = no['response_type']
            if rtype == "bool" or rtype == "boolean":
                response = no['response']
                if response == True:
                    self.info("User allowed update using boolean.")
                    # should fetch OTT without url
                    thinx_update(self.AVAILABLE_UPDATE_URL)
                    return True
                else:
                    self.info("User denied update using boolean.")
                    return False

            if rtype == "string" or rtype == "String":
                response = no['response']
                if response == "yes":
                    self.info("User allowed update using boolean.")
                    # should fetch OTT without url
                    thinx_update(self.AVAILABLE_UPDATE_URL)
                    return True
                else:
                    self.info("User denied update using boolean.")
                    return False

        except Exception:
            self.error("THINX: No response_type success key...")
            return False

    # FIXME: UNUSED!
    def update_on_registration(self, success, reg):
        if success == "FIRMWARE_UPDATE":
            mac = reg['mac']  # -- TODO: must be current or 'ANY'
            version = reg['version']
            self.info("version: " + version)
            self.info("Starting update...")
            try:
                update_url = reg['url']
                if update_url != None:
                    self.info("Running update with URL:" + update_url)
                    self.thinx_update(update_url)
                    return True
            except Exception:
                self.info("No update url.")

    def apply_registration(self, reg):

        try:
            owner = reg['owner']
            self.config['THINX_OWNER'] = owner
        except Exception as ex:
            self.warning("THINX_OWNER not set in response parser!")
            raise Exception("DevError") from ex
            pass

        try:
            alias = reg['alias']
            self.config['THINX_DEVICE_ALIAS'] = alias
        except Exception:
            self.warning("THINX_DEVICE_ALIAS not set in response parser!")
            raise Exception("DevError") from ex
            pass

        try:
            udid = reg['udid']
            self.config['THINX_UDID'] = udid
            self.dlog(udid)
        except Exception:
            self.warning("THINX_UDID not set in response parser!")
            raise Exception("DevError") from ex
            pass

        self.save_device_info()

        commit = None
        version = None

        try:
            commit = reg['commit']
        except Exception:
            #self.info("THINX_COMMIT_ID not given in response.")
            pass
        
        try:
            version = reg['version']
        except Exception:
            #self.info("THINX_FIRMWARE_VERSION not given in response.")
            pass

        if ((commit == self.config.get('THINX_COMMIT_ID')) and (version == self.config.get('THINX_FIRMWARE_VERSION'))):
            self.info("Firmware has been updated.")
            self.AVAILABLE_UPDATE_URL = None
            self.save_device_info()
            self.notify_on_successful_update()
            return True
        else:
            self.info("Firmware is up-to-date.")

    def parse_registration(self, response):

        try:
            reg = response['registration']
        except Exception:
            self.error("THiNX: No registration key found.")

        if not reg:
            return

        try:
            success = reg['success']
            if success == False:
                self.error("THiNX: Registration failure.")
                return
        except Exception:
            self.warning("THINX: No registration success key...")

        #self.info("Will apply registration...")
        if success == True:
            self.apply_registration(reg)
            if self.registration_callback != None:
                self.info("Calling registration_callback...")
                self.registration_callback()

        return self.update_and_reboot(reg)

    def parse_update(self, response):

        url = None

        try:
            upd = response['registration']['update']
        except Exception:
            self.info("No update key found.")
            return False

        try:
            mac = upd['mac']
        except Exception:
            self.info("No mac key found.")

        try:
            commit = upd['commit']
        except Exception:
            self.info("No commit key found.")

        try:
            version = upd['version']
        except Exception:
            self.info("No version key found.")

        try:
            url = upd['url']
        except Exception:
            self.info("No url key found.")

        if commit == self.config.get('THINX_COMMIT_ID') and version == self.config.get('THINX_FIRMWARE_VERSION'):
            self.info("Firmware has been updated.")
            self.AVAILABLE_UPDATE_URL = None
            save_device_info()
            notify_on_successful_update()
            return True
        else:
            self.info("Firmware is up-to-date.")

        if self.config.get('THINX_AUTO_UPDATE') == False:
            self.send_update_question()
            return False

        self.warning("Starting update...")
        if url == None:
            return False

        self.AVAILABLE_UPDATE_URL = url
        self.save_device_info()

        if self.AVAILABLE_UPDATE_URL == None:
            return False

        self.info("Force update URL:" + self.AVAILABLE_UPDATE_URL)
        self.thinx_update(self.AVAILABLE_UPDATE_URL)
        return True

    def notify_on_successful_update(self):
        if self.mqtt_client != None:
            self.mqtt_client.publish(self.mqtt_status_channel(
            ), self.thx_update_success, self.MQTT_LWT_RETAIN, self.MQTT_LWT_QOS)
            self.info("notify_on_successful_update: sent")
        else:
            self.info("notify_on_successful_update: Device updated but MQTT not active to notify. TODO: Store.")

    def send_update_question(self):
        if self.mqtt_client != None:
            self.mqtt_client.publish(self.mqtt_status_channel(
            ), self.thx_update_question, self.MQTT_LWT_RETAIN, self.MQTT_LWT_QOS)
            self.info("send_update_question: sent")
        else:
            self.warning("send_update_question: Device updated but MQTT not active to notify. TODO: Store.")

    # UPDATES
    # -- the update payload may contain files, URL or OTT
    def update_file(self, name, data):
        try:
            afile = open(name, 'w')
            afile.write(response)
            afile.close()
            return True
        except Exception:
            return False

    def request_headers(self):
        return {
            'Authentication': self.config.get('THINX_API_KEY'),
            'Accept': CONTENT_TYPE,
            'Origin': 'device',
            'Content-Type': CONTENT_TYPE,
            'User-Agent': 'THiNX-Client'
        }

    def update_from_url(self, name, url):
        resp = requests.get(url, headers=self.request_headers())
        if resp:
            self.info("THiNX: Server replied...")
            self.update_and_reboot(resp)
            resp.close()  # maybe sooner or not at all?
        else:
            self.error("THINX: Update from URL failed...")

    def reboot(self):
        try:
            stream = os.popen("sudo reboot")
            output = stream.read()
        except Exception as e:
            self.error("Reboot exception" + e)

    def update_and_reboot(self, payload):

        files = None
        ott = None
        success = False

        try:
            files = payload['files']
            ott = payload['ott']
            url = payload['url']
        except Exception:
            pass

        try:
            ptype = payload['type']
        except Exception:
            ptype = "file"

        name = 'thinx.new'

        if files:
            os.rename(r'thinx.py', r'thinx.bak')
            success = False
            for ufile in files:
                try:
                    name = ufile['name']
                except Exception:
                    pass
                try:
                    data = ufile['data']
                except Exception:
                    pass
                try:
                    url = ufile['url']
                except Exception:
                    pass
                if name and data:
                    success = self.update_file(name, data)
                elif name != None and url != None:
                    self.update_from_url(name, url)
                    success = True  # to prevent rollback
                else:
                    self.warning("MQTT Update payload has invalid file descriptors.")

        if ott:
            if ptype == "file":
                self.warning("THINX: Updating " + name + " from URL " + url)
                self.update_from_url(name, url)
                self.warning("THINX: rebooting...")
                success = True  # to prevent rollback
            else:
                self.info("Whole firmware update will be supported in future.")

        if not success:
            if files:
                os.rename(r'thinx.bak', r'thinx.lua')
                self.info("THINX: Update aborted.")
            return

        self.info("THINX: Update successful, rebooting...")
        self.mqtt_publish(self.mqtt_status_channel(), self.thx_reboot_response)
        self.reboot()

    def start(self):
        self.info("-= THiNXLib for Python v0.1.1 =-")
        self.restore_device_info()
        self.thinx_register() # requires network connection

    def main(self):
        while True:
            try:
                thinx()
            except TypeError:
                pass
            # deprecated
