#-------------------------------------------------------------------------------
# Name:        module1
# Purpose:
#
# Author:      liyingho
#
# Created:     07/13/2019
# Copyright:   (c) liyingho 2017
# Licence:     <your licence>
#-------------------------------------------------------------------------------
import  paramiko
class ParamikoClient:
    def __init__(self, url, username, password):
        self._url = url
        self._username = username
        self._password = password

        self._connection = None
        self._returnStr = ''
        self._hasError = False
        self._ftp = None
        self._channel = None

    @property
    def Ftp(self):
        return self._ftp
    @property
    def Connection(self):
        return self._connection

    def Connect(self):
        self._connection = paramiko.SSHClient()
        self._connection.load_system_host_keys()
        self._connection.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        self._connection.connect(self._url, port=22, username=self._username, password=self._password)
        self._ftp = self._connection.open_sftp()
        pass

    def ExecuteShellCommand(self, command):
        try:
            command = '%s; echo exitStatus=$?' % (command)
            stdin, stdout, stderr = self._connection.exec_command(command)
            stdin.close()
            commandOutput = stdout.read()
            commandOutputArray = commandOutput.splitlines()
            exitStatus = commandOutputArray.pop(-1).replace('exitStatus=', '')
        except Exception as e:
            print(str(e))
        return exitStatus, commandOutput

    def ExecuteWindoShellCommand(self, command):
        pid = 0
        try:
            command = 'echo $$; exec '.format(command)
            stdin, stdout, stderr = self._connection.exec_command(command)
            stdin.close()
            pid = int(stdout.readline())
        except Exception as e:
            print(str(e))
        return pid

    def ExecuteCommand(self, command, path=''):
        try:
            command = r'{0}{1}'.format(path, command)
            stdin, stdout, stderr = self._connection.exec_command(command)
            stdin.close()
            error = str(stderr.read())

            if error:
                self._hasError = True
                self._returnStr = error
                print ('Executing command [{0}] has error : {1}'.format(command, error))
            else:
                self._hasError = False
                self._returnStr = stdout.read()
                print ('Executing command [{0}] success, return string = {1}.\n'.format(command, self._returnStr))

        except Exception as e:
            self._returnStr = "Exception caught at executing command [{0}], {1}".format(command, str(e))
        return self._returnStr

    def Close(self):
        if self._connection is not None:
            self._connection.close()

if __name__ == '__main__':

    import argparse
    parser = argparse.ArgumentParser()

    path = '/usr/local/bin/'
    parser.add_argument('-i', action='store', dest='url', help="Bmc ip address", default='10.23.52.234')
    parser.add_argument('-u', action='store', dest='username', help="BMC user name", default='root')
    parser.add_argument('-p', action='store', dest='password', help="Bmc password", default='0penBmc')

    args = parser.parse_args()
    client = ParamikoClient(args.url, args.username, args.password)
    client.Connect()
    for command in ['me-util 0x18 0x01',
                    'me-util 0xB8 0xc8 0x57 0x01 0x00 0x01 0x00 0x01',  #Get NM statistics
                    'sensor-util all', 'ipmi-util 0 0x18 0x01']:#['ls -l']:#
        ret = client.ExecuteCommand(command, path)
        print('Command = {0}\n{1}\n').format(command, ret)

    targetclient = ParamikoClient('10.23.60.7', 'dcpae', 'p@ssw0rd123')
    #targetclient = ParamikoClient('10.23.60.26', 'Administrator', 'p@ssw0rd123')
    targetclient.Connect()
    ret = targetclient.ExecuteShellCommand('stress --cpu 4 --timeout 60')#stress --cpu 4 --timeout 60')

    pass
