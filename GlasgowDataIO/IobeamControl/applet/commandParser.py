from amaranth import *
from amaranth.lib import wiring
from amaranth.lib.wiring import In, Out
from . import *
from ..commands.low_level_commands import Command, ExternalCtrlCommand, CmdType, BitLayout
from GlasgowDataIO.IobeamControl.applet import *

class CommandParser(wiring.Component):
    usb_stream: In(StreamSignature(8)) # type: ignore
    cmd_stream: Out(StreamSignature(Command)) # type: ignore

    def elaborate(self, platform):
        m = Module()
        self.command = Signal(Command)
        m.d.comb += self.cmd_stream.payload.eq(self.command)
        self.command_reg = Signal(Command)
        array_length = Signal(16)

        self.is_started = Signal()
        with m.FSM() as fsm:
            m.d.comb += self.is_started.eq(fsm.ongoing("Type"))
            def goto_first_deserialized_state(from_type=self.command.type):
                with m.Switch(from_type):
                    for cmdtype, state_sequence in Command.deserialized_states.items():
                        with m.Case(cmdtype):
                            if len(state_sequence.keys()) > 0:
                                m.next = list(state_sequence.keys())[0]
                            else:
                                m.next = "Submit"

            with m.State("Type"):
                m.d.comb += self.usb_stream.ready.eq(1)
                with m.If(self.usb_stream.valid):
                    # Gemine suggested ---------------------
                    # m.d.comb += self.command.type.eq(self.usb_stream.payload[4:8]) --- commented out by Gemini, since we want to preserve the Type and BitLayout fields in the command register when deserializing an array command, which means we can't directly assign the Type field from the USB stream at this point since it may be overwritten later when we deserialize the first element of an array command. Instead, we can assign the Type field from the USB stream in the "Submit" state after we've determined whether we're dealing with an array command or not. This way, we can ensure that the Type field is correctly set for both array and non-array commands without having to worry about preserving it during deserialization.
                    # m.d.comb += self.command.payload.as_value()[0:4].eq(self.usb_stream.payload[0:4]) --- commented out by Gemini, since we want to preserve the Type and BitLayout fields in the command register when deserializing an array command, which means we can't directly assign the payload bits from the USB stream at this point since they may be overwritten later when we deserialize the first element of an array command. Instead, we can assign the payload bits from the USB stream in the "Submit" state after we've determined whether we're dealing with an array command or not. This way, we can ensure that the payload bits are correctly set for both array and non-array commands without having to worry about preserving them during deserialization.
                    # 1. High nibble of USB byte -> Struct type (bits 0-3)
                    m.d.comb += self.command.type.eq(self.usb_stream.payload[4:8])                   
                    # 2. Low nibble of USB byte -> Struct payload bits (bits 4-7)
                    # Use [4:8] to target the start of the payload field
                    m.d.comb += self.command.as_value()[4:8].eq(self.usb_stream.payload[0:4])
                    m.d.sync += self.command_reg.eq(self.command)
                    goto_first_deserialized_state()
                    

            def Deserialize(target, state, next_state):
                m.d.comb += self.command.eq(self.command_reg)
                #print(f'state: {state} -> next state: {next_state}')
                with m.State(state):
                    m.d.comb += self.usb_stream.ready.eq(1)
                    with m.If(self.usb_stream.valid):
                        m.d.sync += target.eq(self.usb_stream.payload)
                        m.next = next_state
            
            for state_sequence in Command.deserialized_states.values():
                for n, (state, offset) in enumerate(state_sequence.items()):
                    if n < len(state_sequence) - 1:
                        next_state = list(state_sequence.keys())[n+1]
                    elif n == len(state_sequence) - 1:
                        next_state = "Submit"
                    Deserialize(self.command_reg.as_value()[offset:offset+8], state, next_state)


            with m.State("Submit"):
                m.d.comb += self.command.eq(self.command_reg)
                with m.If(self.command.type == CmdType.Array):
                        m.d.sync += self.command_reg.type.eq(self.command.payload.array.cmdtype)
                        # Gmini had an optimization here to only clear the byte-level data (bits 8 and up) when starting to deserialize an array command, preserving the Type and BitLayout fields in bits 0-7. This allows us to avoid having to re-deserialize the Type and BitLayout for every element in the array, since they are the same for all elements. We just need to make sure to clear the byte-level data before starting to deserialize the next command after the array is done, which is handled in the "Type" state.
                        # m.d.sync += self.command_reg.as_value()[4:].eq(0)
                        # Clear only the byte-level data (bits 8 and up), preserving Type and BitLayout# Clear only the byte-level data (bits 8 and up), preserving Type and BitLayout
                        m.d.sync += self.command_reg.as_value()[4:].eq(0)
                        m.d.sync += array_length.eq(self.command.payload.array.array_length)
                        goto_first_deserialized_state(from_type=self.command.payload.array.cmdtype)
                with m.Else():
                    with m.If(self.cmd_stream.ready):
                        m.d.comb += self.cmd_stream.valid.eq(1)
                        with m.If(array_length != 0):
                            m.d.sync += array_length.eq(array_length - 1)
                            goto_first_deserialized_state()
                        with m.Else():
                            m.next = "Type"
        return m

