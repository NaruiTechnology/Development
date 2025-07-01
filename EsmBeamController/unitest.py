import unittest
from Software.commands.low_level_commands import *
from Software.applet.BeamControlApplet import *  # Add this import if BeamControlApplet is defined in this module

class TestControllerHub(unittest.TestCase):
    def setUp(self):
        pass    

    def test_initial_my_applet(self):
        try:
            applet = BeamControlApplet()
        except Exception as e:
            self.fail(f"Command parser failed with exception: {e}")
            
    def test_command_parser(self):
        pass
        
if __name__ == '__main__':
    unittest.main()