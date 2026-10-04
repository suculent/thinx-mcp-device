#!/usr/bin/python
# -*- coding: utf-8 -*-

import os
import threading

from lib.PerpetualTimer import PerpetualTimer
from lib.Hardware import Hardware

from thinx.thinx import THiNX

from datetime import datetime

from guizero import App
from guizero import info
from guizero import Text, TextBox, PushButton, Slider, Picture, CheckBox, ButtonGroup

class Application():

    # UI Responders

    def say_my_name(self):
        self.ui_text.value = self.ui_text_box.value

    def change_text_size(self, slider_value):
        self.ui_clock.size = slider_value

    def do_test_publish(self):
        self.thinx.publish('{ "status" : "Test message from RPi device." }')
        # info("THiNX", "TODO: message has NOT been published.")

    def registration_callback(self):
        self.ui_test_button.enable()
        #self.app.update()
        print("[APP] Successfully registered")

    def mqtt_callback(self, msg):
        message = msg.payload.decode("utf-8")
        topic = msg.topic
        print("[APP] Incoming message: " + message)
        info("MQTT", message)

    # App

    def __init__(self):

        self.app = App(title="THiNX App", width=800, height=480)

        # UI Widgets

        self.ui_logo = Picture(self.app, image="assets/logo.png")

        self.ui_clock = Text(self.app, text="00:00:00", size=20, font="Hack", color="darkgrey")
        
        self.ui_text = Text(self.app, text="Welcome", size=10, font="Hack", color="darkgrey")

        self.ui_test_button = PushButton(self.app, command=self.do_test_publish, text="Publish Test")
        # self.ui_test_button.enabled = False; # problem with re-enabling from callback on background thread

        # Other sample widgets
        # self.ui_text_box = TextBox(self.app, grid=[1,1])
        
        #self.ui_process_button = PushButton(self.app, command=self.say_my_name, text="Process Input", grid=[1,2])
        #self.ui_text_slider = Slider(self.app, command=self.change_text_size, start=10, end=32, grid=[2,3])
        #self.ui_check_box = CheckBox(self.app, text="VIP seat?", grid=[1,4], align="left")
        # invalid syntax on rpi self.ui_row_selector = ButtonGroup(self.app, options=[ ["Front", "F"], ["Middle", "M"],["Back", "B"] ], selected="M", horizontal=True, grid=[1,5], align="left")

        # Background Timer

        def update_display_time(self=self):
            tempo = datetime.today()
            clock = "{:02d}:{:02d}:{:02d}".format(tempo.hour, tempo.minute, tempo.second)
            try:
                self.ui_clock.value = clock # uses default argument because timer does not send one implicitly
            except RuntimeError:
                exit()

        t = PerpetualTimer(1, update_display_time)
        t.start()

        h = Hardware()

        self.ui_text.value = h.get_serial()

        self.thinx = THiNX()

        # handles aquiring UDID after API registration
        self.thinx.registration_callback = self.registration_callback

        # handles mqtt messages
        self.thinx.mqtt_callback = self.mqtt_callback

        self.app.full_screen = True
        self.app.display()

        self.thinx.mqtt_client.loop_forever();

app = Application()